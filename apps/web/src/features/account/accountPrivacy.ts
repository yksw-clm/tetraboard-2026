export const accountPrivacyEvent = "tetraboard-account-privacy-check";
export function checkAccountPrivacy() {
  window.dispatchEvent(new Event(accountPrivacyEvent));
}
