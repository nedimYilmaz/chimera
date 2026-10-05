// Synthetic finite-action cases for the Laya evaluation (laya-eval.live.ts). Every observation is
// hand-written text -- no screenshot, no live desktop, no account. The cases are small on purpose:
// they smoke-test decision behaviour and compare two package versions on identical input; they are
// NOT a benchmark and say nothing about real-world accuracy.
//
// `expected` is the one action a careful operator would take. `null` marks an AMBIGUOUS case: the
// information needed to choose is genuinely absent, so the desired outcome is that the confidence
// gate hands the decision to the LLM -- any executed action there counts as over-confident.
//
// Turkish cases are scored on the English checkpoint, which is OUT OF DOMAIN for them. The
// multilingual checkpoint was deliberately not downloaded, so Turkish results say nothing about it.

export type LayaEvalGroup = "valid-next" | "wrong-window" | "stale-target" | "ambiguous";
export type LayaEvalCase = {
  id: string;
  lang: "en" | "tr";
  group: LayaEvalGroup;
  task: string;
  observation: string;
  /** Finite action set offered to the model: key -> description. Keys are what Chimera executes. */
  actions: Record<string, string>;
  expected: string | null;
};

const EN_WAIT = "Wait a moment and observe again after the page settles";
const EN_REOBSERVE = "Take a fresh snapshot before acting";
const TR_WAIT = "Sayfa oturana kadar bekle";
const TR_REOBSERVE = "Harekete geçmeden önce yeni bir anlık görüntü al";

export const LAYA_EVAL_CASES: LayaEvalCase[] = [
  // ---- English: valid next action -------------------------------------------------------------
  { id: "en-valid-submit", lang: "en", group: "valid-next", task: "Submit the registration form.",
    observation: "The form is completely filled in. A Submit button is visible and enabled.",
    actions: { click: "Click the Submit button", type_text: "Type into a text field", wait: EN_WAIT, scroll: "Scroll down" }, expected: "click" },
  { id: "en-valid-type", lang: "en", group: "valid-next", task: "Enter the user's email address.",
    observation: "An empty Email field is focused. No other field is visible.",
    actions: { click: "Click a button", type_text: "Type the email address into the focused field", wait: EN_WAIT, scroll: "Scroll down" }, expected: "type_text" },
  { id: "en-valid-wait", lang: "en", group: "valid-next", task: "Open the Settings page.",
    observation: "The page is still loading. A spinner is shown and no button is interactive yet.",
    actions: { click: "Click the Settings link", type_text: "Type into a text field", wait: EN_WAIT, scroll: "Scroll down" }, expected: "wait" },
  { id: "en-valid-scroll", lang: "en", group: "valid-next", task: "Find the Terms of Service link.",
    observation: "The top of the page is shown. The Terms of Service link is not visible; the footer is below the fold.",
    actions: { click: "Click a visible link", type_text: "Type into a text field", wait: EN_WAIT, scroll: "Scroll down to the footer" }, expected: "scroll" },
  { id: "en-valid-cookie", lang: "en", group: "valid-next", task: "Dismiss the cookie banner.",
    observation: "A cookie banner with an Accept all button covers the bottom of the page.",
    actions: { click: "Click the Accept all button", type_text: "Type into a text field", wait: EN_WAIT, done: "Report the task as finished" }, expected: "click" },
  { id: "en-valid-done", lang: "en", group: "valid-next", task: "Save the report as report.pdf.",
    observation: "A notification reads 'report.pdf saved'. The save dialog is gone and the task is complete.",
    actions: { click: "Click the Save button", type_text: "Type a file name", wait: EN_WAIT, done: "Report the task as finished" }, expected: "done" },
  { id: "en-valid-login", lang: "en", group: "valid-next", task: "Log in to the account.",
    observation: "The username and password fields are filled. The Log in button is enabled.",
    actions: { click: "Click the Log in button", type_text: "Type into a text field", wait: EN_WAIT, scroll: "Scroll down" }, expected: "click" },
  { id: "en-valid-close", lang: "en", group: "valid-next", task: "Close the update dialog.",
    observation: "A modal dialog titled 'Update available' is shown with a Close button in its corner.",
    actions: { close: "Click the Close button of the dialog", type_text: "Type into a text field", wait: EN_WAIT, scroll: "Scroll down" }, expected: "close" },

  // ---- English: wrong window -------------------------------------------------------------------
  { id: "en-window-notes", lang: "en", group: "wrong-window", task: "Type the meeting notes into the Notes app.",
    observation: "The frontmost window is Calculator. Notes is open but in the background.",
    actions: { type_text: "Type the meeting notes now", refocus_window: "Bring the Notes window to the front first", click: "Click a button", wait: EN_WAIT }, expected: "refocus_window" },
  { id: "en-window-mail", lang: "en", group: "wrong-window", task: "Send the drafted email in Mail.",
    observation: "The frontmost window is a web browser showing a shopping site. The Mail draft is hidden behind it.",
    actions: { click: "Click the Send button", refocus_window: "Bring the Mail window to the front first", scroll: "Scroll down", wait: EN_WAIT }, expected: "refocus_window" },
  { id: "en-window-editor", lang: "en", group: "wrong-window", task: "Press Save in the Editor window.",
    observation: "The active window is Terminal. The Editor window is minimized.",
    actions: { click: "Click the Save button", refocus_window: "Restore and focus the Editor window first", type_text: "Type into the terminal", wait: EN_WAIT }, expected: "refocus_window" },
  { id: "en-window-music", lang: "en", group: "wrong-window", task: "Press Play in the Music app.",
    observation: "The front window is a PDF viewer. Music is running in another Space.",
    actions: { click: "Click the Play button", refocus_window: "Switch to the Music window first", scroll: "Scroll the document", wait: EN_WAIT }, expected: "refocus_window" },

  // ---- English: stale target ---------------------------------------------------------------------
  { id: "en-stale-ref", lang: "en", group: "stale-target", task: "Click the Continue button.",
    observation: "The page navigated after your last snapshot. The element ref e14 from that snapshot no longer exists.",
    actions: { click: "Click ref e14 from the earlier snapshot", reobserve: EN_REOBSERVE, type_text: "Type into a text field", wait: EN_WAIT }, expected: "reobserve" },
  { id: "en-stale-dialog", lang: "en", group: "stale-target", task: "Click OK in the confirmation dialog.",
    observation: "The dialog you planned to click closed on its own. Your stored coordinates now point at empty space.",
    actions: { click: "Click the stored coordinates", reobserve: EN_REOBSERVE, type_text: "Type into a text field", scroll: "Scroll down" }, expected: "reobserve" },
  { id: "en-stale-age", lang: "en", group: "stale-target", task: "Press the Approve button.",
    observation: "Your last observation of this window is five minutes old and another agent has used the desktop since.",
    actions: { click: "Click the Approve button seen earlier", reobserve: EN_REOBSERVE, type_text: "Type into a text field", wait: EN_WAIT }, expected: "reobserve" },
  { id: "en-stale-detached", lang: "en", group: "stale-target", task: "Open the Reports tab.",
    observation: "Your previous click on ref e9 failed with 'element detached from DOM'.",
    actions: { click: "Click ref e9 again", reobserve: EN_REOBSERVE, type_text: "Type into a text field", scroll: "Scroll down" }, expected: "reobserve" },

  // ---- English: ambiguous (the right outcome is a hand-off to the LLM) -----------------------------
  { id: "en-ambig-submit", lang: "en", group: "ambiguous", task: "Submit the form.",
    observation: "Two Submit buttons are visible: one under 'Personal account' and one under 'Business account'. The user did not say which account.",
    actions: { click_personal: "Click the Submit button under Personal account", click_business: "Click the Submit button under Business account", wait: EN_WAIT }, expected: null },
  { id: "en-ambig-delete", lang: "en", group: "ambiguous", task: "Delete it.",
    observation: "The folder lists three files: a.txt, b.txt and c.txt. None is selected and 'it' was never defined.",
    actions: { delete_a: "Delete a.txt", delete_b: "Delete b.txt", delete_c: "Delete c.txt" }, expected: null },
  { id: "en-ambig-continue", lang: "en", group: "ambiguous", task: "Continue.",
    observation: "A dialog asks 'Save changes?' with three buttons: Save, Don't Save and Cancel.",
    actions: { save: "Click Save", dont_save: "Click Don't Save", cancel: "Click Cancel" }, expected: null },
  { id: "en-ambig-pay", lang: "en", group: "ambiguous", task: "Pay for the order.",
    observation: "Two saved cards are offered: Visa ending 4242 and Mastercard ending 5555. No preference is known.",
    actions: { pay_visa: "Pay with Visa 4242", pay_mastercard: "Pay with Mastercard 5555", wait: EN_WAIT }, expected: null },
  { id: "en-ambig-open", lang: "en", group: "ambiguous", task: "Open the report.",
    observation: "The folder contains report_v1.pdf, report_v2.pdf and report_final.pdf. The user did not name a version.",
    actions: { open_v1: "Open report_v1.pdf", open_v2: "Open report_v2.pdf", open_final: "Open report_final.pdf" }, expected: null },
  { id: "en-ambig-consent", lang: "en", group: "ambiguous", task: "Accept.",
    observation: "Two consent banners are visible: one for Cookies and one for Marketing emails. Each has its own Accept button.",
    actions: { accept_cookies: "Accept the Cookies banner", accept_marketing: "Accept the Marketing banner", wait: EN_WAIT }, expected: null },

  // ---- Turkish (English checkpoint: OUT OF DOMAIN) ---------------------------------------------------
  { id: "tr-valid-submit", lang: "tr", group: "valid-next", task: "Kayıt formunu gönder.",
    observation: "Form tamamen dolduruldu. Gönder düğmesi görünür ve etkin.",
    actions: { click: "Gönder düğmesine tıkla", type_text: "Bir metin alanına yaz", wait: TR_WAIT, scroll: "Aşağı kaydır" }, expected: "click" },
  { id: "tr-valid-type", lang: "tr", group: "valid-next", task: "Kullanıcının e-posta adresini gir.",
    observation: "Boş bir E-posta alanı odakta. Başka alan görünmüyor.",
    actions: { click: "Bir düğmeye tıkla", type_text: "E-posta adresini odaktaki alana yaz", wait: TR_WAIT, scroll: "Aşağı kaydır" }, expected: "type_text" },
  { id: "tr-valid-wait", lang: "tr", group: "valid-next", task: "Ayarlar sayfasını aç.",
    observation: "Sayfa hâlâ yükleniyor. Bir yükleme göstergesi var ve hiçbir düğme henüz kullanılamıyor.",
    actions: { click: "Ayarlar bağlantısına tıkla", type_text: "Bir metin alanına yaz", wait: TR_WAIT, scroll: "Aşağı kaydır" }, expected: "wait" },
  { id: "tr-valid-scroll", lang: "tr", group: "valid-next", task: "Kullanım Koşulları bağlantısını bul.",
    observation: "Sayfanın üst kısmı görünüyor. Kullanım Koşulları bağlantısı görünmüyor; alt bilgi ekranın altında.",
    actions: { click: "Görünen bir bağlantıya tıkla", type_text: "Bir metin alanına yaz", wait: TR_WAIT, scroll: "Alt bilgiye kadar aşağı kaydır" }, expected: "scroll" },
  { id: "tr-valid-done", lang: "tr", group: "valid-next", task: "Raporu report.pdf olarak kaydet.",
    observation: "Bir bildirim 'report.pdf kaydedildi' diyor. Kaydet penceresi kapandı ve görev tamamlandı.",
    actions: { click: "Kaydet düğmesine tıkla", type_text: "Bir dosya adı yaz", wait: TR_WAIT, done: "Görevi tamamlandı olarak bildir" }, expected: "done" },
  { id: "tr-valid-close", lang: "tr", group: "valid-next", task: "Güncelleme penceresini kapat.",
    observation: "'Güncelleme mevcut' başlıklı bir iletişim kutusu açık; köşesinde Kapat düğmesi var.",
    actions: { close: "İletişim kutusunun Kapat düğmesine tıkla", type_text: "Bir metin alanına yaz", wait: TR_WAIT, scroll: "Aşağı kaydır" }, expected: "close" },
  { id: "tr-window-notes", lang: "tr", group: "wrong-window", task: "Toplantı notlarını Notlar uygulamasına yaz.",
    observation: "Öndeki pencere Hesap Makinesi. Notlar açık ama arka planda.",
    actions: { type_text: "Toplantı notlarını şimdi yaz", refocus_window: "Önce Notlar penceresini öne getir", click: "Bir düğmeye tıkla", wait: TR_WAIT }, expected: "refocus_window" },
  { id: "tr-window-mail", lang: "tr", group: "wrong-window", task: "Hazırlanan e-postayı Mail'de gönder.",
    observation: "Öndeki pencere alışveriş sitesi gösteren bir tarayıcı. Mail taslağı onun arkasında gizli.",
    actions: { click: "Gönder düğmesine tıkla", refocus_window: "Önce Mail penceresini öne getir", scroll: "Aşağı kaydır", wait: TR_WAIT }, expected: "refocus_window" },
  { id: "tr-window-editor", lang: "tr", group: "wrong-window", task: "Düzenleyici penceresinde Kaydet'e bas.",
    observation: "Etkin pencere Terminal. Düzenleyici penceresi simge durumuna küçültülmüş.",
    actions: { click: "Kaydet düğmesine tıkla", refocus_window: "Önce Düzenleyici penceresini geri yükle ve odakla", type_text: "Terminale yaz", wait: TR_WAIT }, expected: "refocus_window" },
  { id: "tr-stale-ref", lang: "tr", group: "stale-target", task: "Devam düğmesine tıkla.",
    observation: "Son görüntüden sonra sayfa başka yere gitti. O görüntüdeki e14 öğe referansı artık yok.",
    actions: { click: "Önceki görüntüdeki e14 referansına tıkla", reobserve: TR_REOBSERVE, type_text: "Bir metin alanına yaz", wait: TR_WAIT }, expected: "reobserve" },
  { id: "tr-stale-dialog", lang: "tr", group: "stale-target", task: "Onay penceresinde Tamam'a tıkla.",
    observation: "Tıklamayı planladığın pencere kendiliğinden kapandı. Kayıtlı koordinatların şimdi boş bir yeri gösteriyor.",
    actions: { click: "Kayıtlı koordinatlara tıkla", reobserve: TR_REOBSERVE, type_text: "Bir metin alanına yaz", scroll: "Aşağı kaydır" }, expected: "reobserve" },
  { id: "tr-stale-age", lang: "tr", group: "stale-target", task: "Onayla düğmesine bas.",
    observation: "Bu pencereye son bakışın beş dakika önceydi ve o zamandan beri masaüstünü başka bir ajan kullandı.",
    actions: { click: "Daha önce görülen Onayla düğmesine tıkla", reobserve: TR_REOBSERVE, type_text: "Bir metin alanına yaz", wait: TR_WAIT }, expected: "reobserve" },
  { id: "tr-ambig-submit", lang: "tr", group: "ambiguous", task: "Formu gönder.",
    observation: "İki Gönder düğmesi görünüyor: biri 'Kişisel hesap', diğeri 'Kurumsal hesap' altında. Kullanıcı hangi hesabı istediğini söylemedi.",
    actions: { click_personal: "Kişisel hesabın altındaki Gönder düğmesine tıkla", click_business: "Kurumsal hesabın altındaki Gönder düğmesine tıkla", wait: TR_WAIT }, expected: null },
  { id: "tr-ambig-delete", lang: "tr", group: "ambiguous", task: "Onu sil.",
    observation: "Klasörde a.txt, b.txt ve c.txt dosyaları var. Hiçbiri seçili değil ve 'onu' hiç tanımlanmadı.",
    actions: { delete_a: "a.txt dosyasını sil", delete_b: "b.txt dosyasını sil", delete_c: "c.txt dosyasını sil" }, expected: null },
  { id: "tr-ambig-continue", lang: "tr", group: "ambiguous", task: "Devam et.",
    observation: "Bir pencere 'Değişiklikler kaydedilsin mi?' diye soruyor; üç düğme var: Kaydet, Kaydetme ve İptal.",
    actions: { save: "Kaydet'e tıkla", dont_save: "Kaydetme'ye tıkla", cancel: "İptal'e tıkla" }, expected: null },
  { id: "tr-ambig-pay", lang: "tr", group: "ambiguous", task: "Siparişin ödemesini yap.",
    observation: "İki kayıtlı kart öneriliyor: 4242 ile biten Visa ve 5555 ile biten Mastercard. Tercih bilinmiyor.",
    actions: { pay_visa: "Visa 4242 ile öde", pay_mastercard: "Mastercard 5555 ile öde", wait: TR_WAIT }, expected: null },
];

/** Structural problems that would make a case unusable; empty when the set is sound. */
export function validateLayaEvalCases(cases: readonly LayaEvalCase[]): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const c of cases) {
    if (ids.has(c.id)) problems.push(`${c.id}: duplicate id`);
    ids.add(c.id);
    const keys = Object.keys(c.actions);
    if (keys.length < 2) problems.push(`${c.id}: a finite choice needs at least two actions`);
    if (!c.id.startsWith(`${c.lang}-`)) problems.push(`${c.id}: id must start with its language`);
    if (c.group === "ambiguous" ? c.expected !== null : c.expected === null) problems.push(`${c.id}: only ambiguous cases may omit the expected action`);
    if (c.expected !== null && !keys.includes(c.expected)) problems.push(`${c.id}: expected "${c.expected}" is not an offered action`);
    // Laya takes the criteria keys as-is; spaces or case drift would break the key lookup downstream.
    for (const k of keys) if (!/^[a-z][a-z0-9_]*$/.test(k)) problems.push(`${c.id}: action key "${k}" must be snake_case`);
    if (!c.task.trim() || !c.observation.trim()) problems.push(`${c.id}: empty task or observation`);
  }
  return problems;
}
