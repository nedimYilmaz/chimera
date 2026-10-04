//! Local Speech recognition for meeting address routing. This module receives
//! caller-owned PCM; it never opens a microphone or forwards audio to the daemon.
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, sync::{atomic::{AtomicU64, Ordering}, Mutex, OnceLock}};
use tauri::ipc::Channel;
use tokio::sync::oneshot;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechEvent {
    pub session_id: String,
    pub r#type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub utterance_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub boundary_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub r#final: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

struct Session {
    token: u64,
    channel: Channel<SpeechEvent>,
    ready: bool,
    starting: Option<oneshot::Sender<Result<(), String>>>,
}
static SESSIONS: OnceLock<Mutex<HashMap<String, Session>>> = OnceLock::new();
static NEXT_TOKEN: AtomicU64 = AtomicU64::new(1);
fn sessions() -> &'static Mutex<HashMap<String, Session>> { SESSIONS.get_or_init(|| Mutex::new(HashMap::new())) }

#[cfg(target_os = "macos")]
extern "C" {
    fn chimera_meeting_speech_start(token: u64, config: *const std::ffi::c_char, callback: extern "C" fn(u64, *const std::ffi::c_char));
    fn chimera_meeting_speech_append(token: u64, samples: *const f32, count: usize, rate: f64);
    fn chimera_meeting_speech_finish(token: u64, boundary: *const std::ffi::c_char);
    fn chimera_meeting_speech_stop(token: u64);
}

fn stop_native(token: u64) {
    #[cfg(target_os = "macos")]
    unsafe { chimera_meeting_speech_stop(token); }
    #[cfg(not(target_os = "macos"))]
    let _ = token;
}

#[cfg(target_os = "macos")]
extern "C" fn native_event(token: u64, json: *const std::ffi::c_char) {
    if json.is_null() { return; }
    // Swift owns this string for the duration of the callback; deserialize it
    // before returning. Tokens prevent callbacks reaching reused session IDs.
    let data = unsafe { std::ffi::CStr::from_ptr(json) }.to_bytes();
    if let Ok(event) = serde_json::from_slice::<SpeechEvent>(data) { deliver(token, event); }
}

fn deliver(token: u64, event: SpeechEvent) {
    let Ok(mut registry) = sessions().lock() else { return; };
    let Some(session) = registry.get_mut(&event.session_id).filter(|s| s.token == token) else { return; };
    if !["ready", "transcript", "error"].contains(&event.r#type.as_str()) { return; }
    let disconnected = session.channel.send(event.clone()).is_err();
    if event.r#type == "ready" && !disconnected {
        session.ready = true;
        if let Some(starting) = session.starting.take() { let _ = starting.send(Ok(())); }
    }
    if event.r#type == "error" || disconnected {
        if let Some(starting) = session.starting.take() {
            let _ = starting.send(Err(event.error.unwrap_or_else(|| "Speech event channel closed".into())));
        }
        registry.remove(&event.session_id);
        drop(registry);
        stop_native(token);
    }
}

fn validate_start(id: &str, locale: &str, hints: &[String]) -> Result<(), String> {
    if id.is_empty() || id.len() > 128 || id.contains('\0') { return Err("Invalid speech session ID".into()); }
    if locale.is_empty() || locale.len() > 48 || !locale.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_') { return Err("Invalid speech locale".into()); }
    if hints.len() > 64 || hints.iter().any(|hint| hint.len() > 200 || hint.contains('\0')) { return Err("Speech vocabulary is too large".into()); }
    Ok(())
}
fn validate_audio(samples: &[f32], rate: f64) -> Result<(), String> {
    if samples.is_empty() || samples.len() > 16384 || samples.iter().any(|s| !s.is_finite() || s.abs() > 1.01) { return Err("Invalid local speech PCM buffer".into()); }
    if !rate.is_finite() || !(8000.0..=96000.0).contains(&rate) { return Err("Invalid local speech sample rate".into()); }
    Ok(())
}
fn ready_token(id: &str) -> Result<u64, String> {
    let registry = sessions().lock().map_err(|_| "Speech session lock failed")?;
    let session = registry.get(id).ok_or("Local speech session is not active")?;
    if !session.ready { return Err("Local speech recognition is not ready".into()); }
    Ok(session.token)
}

#[tauri::command]
pub async fn meeting_speech_start(session_id: String, locale: String, contextual_strings: Vec<String>, on_event: Channel<SpeechEvent>) -> Result<(), String> {
    validate_start(&session_id, &locale, &contextual_strings)?;
    #[cfg(not(target_os = "macos"))]
    { let _ = on_event; return Err("Local meeting speech recognition is currently available on macOS only".into()); }
    #[cfg(target_os = "macos")]
    {
        let token = NEXT_TOKEN.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        let config = std::ffi::CString::new(serde_json::json!({"sessionId": session_id, "locale": locale, "contextualStrings": contextual_strings}).to_string()).map_err(|e| e.to_string())?;
        {
            let mut registry = sessions().lock().map_err(|_| "Speech session lock failed")?;
            if registry.contains_key(&session_id) { return Err("Local speech session already exists".into()); }
            if registry.len() >= 8 { return Err("Too many local speech sessions".into()); }
            registry.insert(session_id.clone(), Session { token, channel: on_event, ready: false, starting: Some(tx) });
        }
        unsafe { chimera_meeting_speech_start(token, config.as_ptr(), native_event); }
        match tokio::time::timeout(std::time::Duration::from_secs(120), rx).await {
            Ok(Ok(result)) => result,
            result => {
                let mut registry = sessions().lock().map_err(|_| "Speech session lock failed")?;
                if registry.get(&session_id).is_some_and(|s| s.token == token) { registry.remove(&session_id); }
                drop(registry); stop_native(token);
                Err(if result.is_err() { "Speech authorization or startup timed out" } else { "Speech startup was cancelled" }.into())
            }
        }
    }
}

#[tauri::command]
pub async fn meeting_speech_append(session_id: String, samples: Vec<f32>, sample_rate: f64) -> Result<(), String> {
    validate_audio(&samples, sample_rate)?;
    let token = ready_token(&session_id)?;
    #[cfg(target_os = "macos")]
    unsafe { chimera_meeting_speech_append(token, samples.as_ptr(), samples.len(), sample_rate); }
    #[cfg(not(target_os = "macos"))]
    let _ = token;
    Ok(())
}

#[tauri::command]
pub async fn meeting_speech_finish(session_id: String, boundary_id: Option<String>) -> Result<(), String> {
    let token = ready_token(&session_id)?;
    if boundary_id.as_ref().is_some_and(|id| id.is_empty() || id.len() > 200 || id.contains('\0')) { return Err("Invalid speech boundary ID".into()); }
    #[cfg(target_os = "macos")]
    {
        let boundary = boundary_id.map(std::ffi::CString::new).transpose().map_err(|e| e.to_string())?;
        unsafe { chimera_meeting_speech_finish(token, boundary.as_ref().map_or(std::ptr::null(), |id| id.as_ptr())); }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = token;
    Ok(())
}

#[tauri::command]
pub async fn meeting_speech_stop(session_id: String) -> Result<(), String> {
    let session = sessions().lock().map_err(|_| "Speech session lock failed")?.remove(&session_id);
    if let Some(mut session) = session {
        if let Some(starting) = session.starting.take() { let _ = starting.send(Err("Speech startup was cancelled".into())); }
        stop_native(session.token);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_unbounded_or_nonfinite_audio_before_ffi() {
        for audio in [vec![], vec![f32::NAN], vec![f32::INFINITY], vec![2.0], vec![0.0; 16385]] { assert!(validate_audio(&audio, 48000.0).is_err()); }
        for rate in [f64::NAN, f64::INFINITY, 0.0, 192000.0] { assert!(validate_audio(&[0.1], rate).is_err()); }
        assert!(validate_audio(&vec![0.1; 1024], 48000.0).is_ok());
    }
    #[test]
    fn validates_vocabulary_and_explicit_locale() {
        assert!(validate_start("room", "tr-TR", &["Sohbet arkadaşı".into()]).is_ok());
        assert!(validate_start("room", "", &[]).is_err());
        assert!(validate_start("room", "tr-TR", &vec!["a".into(); 65]).is_err());
        assert!(validate_start("", "tr-TR", &[]).is_err());
    }
    #[test]
    fn ignores_callbacks_for_replaced_session_tokens() {
        let id = "generation-regression".to_string();
        let channel = Channel::new(|_| Ok(()));
        sessions().lock().unwrap().insert(id.clone(), Session { token: 20, channel, ready: false, starting: None });
        deliver(19, SpeechEvent { session_id: id.clone(), r#type: "error".into(), utterance_id: None, boundary_id: None, text: None, r#final: None, error: Some("old request".into()) });
        assert_eq!(sessions().lock().unwrap().get(&id).unwrap().token, 20);
        sessions().lock().unwrap().remove(&id);
    }
    #[test]
    fn ready_event_opens_pcm_gate_and_resolves_startup() {
        let id = "startup-regression".to_string();
        let (tx, mut rx) = oneshot::channel();
        sessions().lock().unwrap().insert(id.clone(), Session { token: 21, channel: Channel::new(|_| Ok(())), ready: false, starting: Some(tx) });
        assert!(ready_token(&id).is_err());
        deliver(21, SpeechEvent { session_id: id.clone(), r#type: "ready".into(), utterance_id: None, boundary_id: None, text: None, r#final: None, error: None });
        assert_eq!(ready_token(&id).unwrap(), 21);
        assert_eq!(rx.try_recv().unwrap(), Ok(()));
        sessions().lock().unwrap().remove(&id);
    }
    #[test]
    fn transcript_wire_preserves_request_identity() {
        let event: SpeechEvent = serde_json::from_str(r#"{"sessionId":"room","type":"transcript","utteranceId":"22:3","text":"Atlas","final":true}"#).unwrap();
        assert_eq!(event.utterance_id.as_deref(), Some("22:3"));
        assert_eq!(serde_json::to_value(event).unwrap()["utteranceId"], "22:3");
    }
}
