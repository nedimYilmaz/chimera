// Official v1.9.4 has source archives only, no macOS/Linux CLI release binary.
// Source downloaded and sha256 measured 2026-10-05 from codeload; local static
// build is recorded with its binary digest and reverified on every launch.
export const STT_RUNTIME = {
  version: "1.9.4", bytes: 9_353_438,
  url: "https://codeload.github.com/ggml-org/whisper.cpp/tar.gz/refs/tags/v1.9.4",
  sha256: "57e280cee375ab02425b806ad5146b99f6eb9357e3c2b31357c8a6af2e2e44ae",
  license: "MIT", provenance: "https://github.com/ggml-org/whisper.cpp/releases/tag/v1.9.4",
};
export const STT_MODEL = {
  id: "small-q5_1" as const, bytes: 190_085_487,
  url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-small-q5_1.bin",
  sha256: "ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb",
  license: "MIT", provenance: "https://huggingface.co/ggerganov/whisper.cpp/tree/main",
};
