// Standalone macOS WebKit boundary probe. No Chimera/daemon startup or credentials.
// Usage: swift scripts/test-design-webkit.swift /path/to/sanitized-preview.html
import AppKit
import WebKit

final class Probe: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
    var web: WKWebView!
    var stage = 0
    var messages = 0
    var rendered = false
    let preview: String
    init(preview: String) { self.preview = preview; super.init() }
    func start() {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        config.userContentController.add(self, name: "probe")
        // Model an injected native bridge in every frame. Generated page scripts
        // still must not be able to call it when sandboxed without allow-scripts.
        config.userContentController.addUserScript(WKUserScript(source: "window.nativeProbe=()=>window.webkit.messageHandlers.probe.postMessage('executed');", injectionTime: .atDocumentStart, forMainFrameOnly: false))
        config.userContentController.addUserScript(WKUserScript(source: "if(window!==window.top){window.webkit.messageHandlers.probe.postMessage({rendered:document.body?.textContent?.includes('Keep things cool.')===true});}", injectionTime: .atDocumentEnd, forMainFrameOnly: false))
        web = WKWebView(frame: NSRect(x: 0, y: 0, width: 1000, height: 700), configuration: config)
        web.navigationDelegate = self
        web.loadHTMLString("<html><body><script>nativeProbe()</script></body></html>", baseURL: nil)
        DispatchQueue.main.asyncAfter(deadline: .now() + 20) { self.finish(false, "timeout") }
    }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        if message.body as? String == "executed" { messages += 1 }
        if let body = message.body as? [String: Any], body["rendered"] as? Bool == true { rendered = true }
    }
    func escaped(_ html: String) -> String {
        html.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "\"", with: "&quot;").replacingOccurrences(of: "<", with: "&lt;")
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) {
            if self.stage == 0 {
                guard self.messages == 1 else { self.finish(false, "positive native bridge control failed"); return }
                self.messages = 0
                self.stage = 1
                // The raw canary tests the sandbox independently of the sanitizer.
                let canary = "<script>nativeProbe()</script><img src='data:bad' onerror='nativeProbe()'>"
                let policy = "default-src 'self'; connect-src 'self' ipc: http://ipc.localhost; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self'; object-src 'none'; base-uri 'self'"
                let html = "<html><head><meta http-equiv=\"Content-Security-Policy\" content=\"\(policy)\"></head><body><iframe sandbox=\"\" srcdoc=\"\(self.escaped(self.preview))\"></iframe><iframe sandbox=\"\" srcdoc=\"\(self.escaped(canary))\"></iframe></body></html>"
                self.web.loadHTMLString(html, baseURL: nil)
            } else if self.stage == 1 {
                self.stage = 2
                self.web.evaluateJavaScript("document.querySelectorAll('iframe').length===2 && [...document.querySelectorAll('iframe')].every(f=>f.contentDocument===null && f.sandbox.length===0)") { value, error in
                    self.finish(error == nil && value as? Bool == true && self.messages == 0 && self.rendered, "HTML rendered in opaque frames, no generated script/native bridge execution")
                }
            }
        }
    }
    func finish(_ passed: Bool, _ detail: String) {
        print("\(passed ? "PASS" : "FAIL") WebKit design boundary: \(detail)")
        exit(passed ? 0 : 1)
    }
}
guard CommandLine.arguments.count == 2, let preview = try? String(contentsOfFile: CommandLine.arguments[1], encoding: .utf8) else {
    print("usage: swift scripts/test-design-webkit.swift SANITIZED_PREVIEW_HTML"); exit(2)
}
let app = NSApplication.shared
app.setActivationPolicy(.prohibited)
let probe = Probe(preview: preview)
probe.start()
app.run()
