import { Link } from "wouter";

const linkClass = "font-semibold text-primary underline-offset-2 hover:underline";

/**
 * The one sign-up acknowledgement shown by every registration method (phone and Google). Terms
 * are accepted; the privacy policy is acknowledged as read — it is a notice, not a blanket consent
 * to every processing purpose. Optional choices (cross-conversation memory, any future marketing)
 * are never bundled here and stay off until the user turns them on.
 */
export function TermsAcknowledgementText() {
  return (
    <span data-testid="terms-acknowledgement">
      أقر بأنني قرأت وأوافق على{" "}
      <Link href="/terms" className={linkClass}>شروط الاستخدام</Link>
      ، وأؤكد اطلاعي على{" "}
      <Link href="/privacy" className={linkClass}>سياسة الخصوصية</Link>.
    </span>
  );
}
