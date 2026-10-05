// H.264 MP4 encode/probe for the usage-video pipeline (scripts/marketing-video-encode.mjs compiles
// and runs this). It exists because the only ffmpeg on a stock machine - the Playwright copy - has no
// H.264 encoder; AVFoundation does, on macOS. Linux/Windows builds simply skip the MP4 and ship WebM.
//
//   marketing-video-mp4 encode <manifest.tsv> <out.mp4> <fps>
//       manifest line: <absolute JPEG path> TAB <how many frames it is shown for>
//   marketing-video-mp4 probe <video.mp4>
//       prints one JSON object: decoded duration, dimensions, codec, frame count, per-frame pixel hash
//
// `probe` decodes every frame through AVAssetReader, so "supported" means a real decode happened.
import AVFoundation
import CoreGraphics
import CoreVideo
import CryptoKit
import Foundation
import ImageIO

func fail(_ message: String) -> Never {
  FileHandle.standardError.write(Data((message + "\n").utf8))
  exit(1)
}

func loadImage(_ path: String) -> CGImage {
  guard let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil),
        let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else { fail("cannot decode \(path)") }
  return image
}

func pixelBuffer(for image: CGImage, pool: CVPixelBufferPool) -> CVPixelBuffer {
  var buffer: CVPixelBuffer?
  guard CVPixelBufferPoolCreatePixelBuffer(nil, pool, &buffer) == kCVReturnSuccess, let out = buffer else { fail("pixel buffer allocation failed") }
  CVPixelBufferLockBaseAddress(out, [])
  defer { CVPixelBufferUnlockBaseAddress(out, []) }
  guard let context = CGContext(
    data: CVPixelBufferGetBaseAddress(out), width: image.width, height: image.height, bitsPerComponent: 8,
    bytesPerRow: CVPixelBufferGetBytesPerRow(out), space: CGColorSpace(name: CGColorSpace.sRGB)!,
    bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue
  ) else { fail("bitmap context failed") }
  context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
  return out
}

func encode(manifest: String, output: String, fps: Int32) {
  let lines = (try? String(contentsOfFile: manifest, encoding: .utf8))?.split(separator: "\n").map(String.init) ?? []
  let entries: [(path: String, count: Int)] = lines.compactMap { line in
    let parts = line.split(separator: "\t")
    guard parts.count == 2, let count = Int(parts[1]), count > 0 else { return nil }
    return (String(parts[0]), count)
  }
  guard let first = entries.first else { fail("empty manifest") }
  let firstImage = loadImage(first.path)
  let width = firstImage.width, height = firstImage.height

  try? FileManager.default.removeItem(atPath: output)
  guard let writer = try? AVAssetWriter(outputURL: URL(fileURLWithPath: output), fileType: .mp4) else { fail("cannot create writer") }
  // Fast-start (moov first) so a static host such as GitHub Pages can begin playback before the whole
  // file is down; no B-frames and a 2s GOP keep seeking and scrubbing cheap.
  writer.shouldOptimizeForNetworkUse = true
  let settings: [String: Any] = [
    AVVideoCodecKey: AVVideoCodecType.h264,
    AVVideoWidthKey: width,
    AVVideoHeightKey: height,
    AVVideoCompressionPropertiesKey: [
      AVVideoProfileLevelKey: AVVideoProfileLevelH264MainAutoLevel,
      AVVideoAllowFrameReorderingKey: false,
      AVVideoMaxKeyFrameIntervalKey: Int(fps) * 2,
      AVVideoAverageBitRateKey: 1_500_000,
    ],
  ]
  let input = AVAssetWriterInput(mediaType: .video, outputSettings: settings)
  input.expectsMediaDataInRealTime = false
  let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [
    kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
    kCVPixelBufferWidthKey as String: width,
    kCVPixelBufferHeightKey as String: height,
  ])
  guard writer.canAdd(input) else { fail("writer rejects the video input") }
  writer.add(input)
  guard writer.startWriting() else { fail("startWriting failed: \(writer.error?.localizedDescription ?? "unknown")") }
  writer.startSession(atSourceTime: .zero)
  guard let pool = adaptor.pixelBufferPool else { fail("no pixel buffer pool") }

  var frameIndex: Int64 = 0
  for entry in entries {
    let image = entry.path == first.path ? firstImage : loadImage(entry.path)
    if image.width != width || image.height != height { fail("frame size changed at \(entry.path)") }
    let buffer = pixelBuffer(for: image, pool: pool)
    for _ in 0..<entry.count {
      while !input.isReadyForMoreMediaData { Thread.sleep(forTimeInterval: 0.002) }
      if !adaptor.append(buffer, withPresentationTime: CMTime(value: frameIndex, timescale: fps)) {
        fail("append failed at frame \(frameIndex): \(writer.error?.localizedDescription ?? "unknown")")
      }
      frameIndex += 1
    }
  }
  input.markAsFinished()
  // End the session at the last frame's full duration so the container duration is frames/fps exactly.
  writer.endSession(atSourceTime: CMTime(value: frameIndex, timescale: fps))
  let done = DispatchSemaphore(value: 0)
  writer.finishWriting { done.signal() }
  done.wait()
  if writer.status != .completed { fail("finishWriting: \(writer.error?.localizedDescription ?? "status \(writer.status.rawValue)")") }
  print("{\"frames\":\(frameIndex),\"width\":\(width),\"height\":\(height)}")
}

func probe(path: String) async {
  let asset = AVURLAsset(url: URL(fileURLWithPath: path))
  let duration = (try? await asset.load(.duration).seconds) ?? 0
  guard let track = try? await asset.loadTracks(withMediaType: .video).first else { fail("no video track in \(path)") }
  let size = (try? await track.load(.naturalSize)) ?? .zero
  let nominalFps = (try? await track.load(.nominalFrameRate)) ?? 0
  let formats = (try? await track.load(.formatDescriptions)) ?? []
  var codec = "unknown"
  if let format = formats.first { codec = fourCC(CMFormatDescriptionGetMediaSubType(format)) }
  guard let reader = try? AVAssetReader(asset: asset) else { fail("cannot read \(path)") }
  let output = AVAssetReaderTrackOutput(track: track, outputSettings: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA])
  reader.add(output)
  guard reader.startReading() else { fail("decode failed to start: \(reader.error?.localizedDescription ?? "unknown")") }
  var frames = 0
  var lastPts = 0.0
  var digest = SHA256()
  while let sample = output.copyNextSampleBuffer() {
    guard let image = CMSampleBufferGetImageBuffer(sample) else { continue }
    CVPixelBufferLockBaseAddress(image, .readOnly)
    let rows = CVPixelBufferGetHeight(image), stride = CVPixelBufferGetBytesPerRow(image), cols = CVPixelBufferGetWidth(image) * 4
    if let base = CVPixelBufferGetBaseAddress(image) {
      var frame = SHA256()
      for row in 0..<rows { frame.update(bufferPointer: UnsafeRawBufferPointer(start: base + row * stride, count: cols)) }
      digest.update(data: Data(frame.finalize()))
    }
    CVPixelBufferUnlockBaseAddress(image, .readOnly)
    lastPts = CMSampleBufferGetPresentationTimeStamp(sample).seconds
    frames += 1
  }
  if reader.status == .failed { fail("decode failed mid-stream: \(reader.error?.localizedDescription ?? "unknown")") }
  let hash = digest.finalize().map { String(format: "%02x", $0) }.joined()
  print("{\"decoder\":\"AVAssetReader\",\"codec\":\"\(codec)\",\"width\":\(Int(size.width)),\"height\":\(Int(size.height)),\"durationSeconds\":\(duration),\"nominalFps\":\(nominalFps),\"decodedFrames\":\(frames),\"lastPresentationSeconds\":\(lastPts),\"decodedHash\":\"\(hash)\"}")
}

func fourCC(_ code: FourCharCode) -> String {
  String(bytes: [UInt8((code >> 24) & 255), UInt8((code >> 16) & 255), UInt8((code >> 8) & 255), UInt8(code & 255)], encoding: .ascii) ?? "?"
}

let args = CommandLine.arguments
if args.count == 5, args[1] == "encode", let fps = Int32(args[4]), fps > 0 {
  encode(manifest: args[2], output: args[3], fps: fps)
} else if args.count == 3, args[1] == "probe" {
  await probe(path: args[2])
} else {
  fail("usage: marketing-video-mp4 encode <manifest.tsv> <out.mp4> <fps> | probe <video.mp4>")
}
