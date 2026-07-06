/**
 * Help-screen FAQs.
 *
 * Externalised from `HelpPage.tsx` so support / ops can iterate copy without
 * touching React code. Keep questions short and answers actionable — these
 * render in a collapsible list on the help screen and are also surfaced in
 * the `Field pilot — quick steps` flow during onboarding.
 */
export type Faq = {
  q: string;
  a: string;
};

export const faqs: Faq[] = [
  {
    q: 'How do I send money for a customer?',
    a: "Go to the 'Services' tab, select 'Send Money', enter the sender's and recipient's phone numbers, and the amount. Collect the cash (including the R10 fee) from the customer before confirming.",
  },
  {
    q: 'How do I pay out cash to a customer?',
    a: "Go to the 'Services' tab, select 'Receive Cash'. Enter the customer's phone number to see pending transfers. Once you hand them the cash, tap 'Pay Out Cash' to credit your shop's digital wallet.",
  },
  {
    q: 'How do I restock my inventory?',
    a: "Go to 'More' > 'Inventory & Stock'. Find the product you want to restock and use the '+' or '+10' buttons to add to your current stock level.",
  },
  {
    q: 'What are the transaction limits?',
    a: 'Basic accounts can transact up to R5,000 per day. Standard accounts up to R25,000. Premium accounts up to R100,000. You can check your tier in Account Settings.',
  },
  {
    q: 'What happens if a transfer fails?',
    a: "If a transfer fails, the funds will immediately bounce back to the sender's wallet. Check your History tab to verify the status of any transaction.",
  },
  {
    q: 'I forgot my PIN — what now?',
    a: "On the PIN screen, tap 'Forgot your PIN?'. We'll send a 6-digit reset code to your registered phone (valid for 10 minutes). Enter it together with a new PIN — all your other devices will be signed out for safety.",
  },
  {
    q: 'How do I close my account?',
    a: "Go to 'Settings' > Danger Zone > 'Close my account'. You'll need to enter your PIN and type the phrase 'DELETE MY ACCOUNT' to confirm. Your wallet balance must be zero before we can close the account.",
  },
];
