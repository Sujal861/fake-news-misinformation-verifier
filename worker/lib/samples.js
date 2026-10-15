/**
 * Demo forwards bundled with the app.
 *
 * These are written to exercise different parts of the engine: a scam, a health
 * hoax, a Hinglish chain forward, a plausible-looking real news message, and a
 * short ambiguous one. They are illustrative text, not real claims about real
 * people.
 */

export const SAMPLES = [
  {
    id: 'whatsapp-charging',
    label: 'WhatsApp will start charging',
    language: 'en',
    text: `Fwd as received!!! IMPORTANT MESSAGE 🚨🚨🚨🚨🚨🚨

WhatsApp is going to CHARGE Rs 500 per year from 1st January. This is being done by Facebook. Our government has approved this new rule.

If you do not forward this message to 10 people, your account will be blocked and all your chats will be deleted. Forward fast before it is deleted!!! Please share with everyone you know.

- Forwarded many times`,
  },
  {
    id: 'miracle-cure',
    label: 'Home remedy cures cancer',
    language: 'en',
    text: `SHOCKING BREAKING NEWS!!!

Doctors don't want you to know this. A 100% cure for cancer has been found — boiling papaya leaves with tulsi kills the virus in 3 days. No side effects, no chemotherapy needed.

BIG PHARMA is hiding this truth from you. Please forward to all your family groups so everyone knows. Share before this message is deleted!

Disclaimer: I got this from my friend who works at a hospital.`,
  },
  {
    id: 'hinglish-free-recharge',
    label: 'Hinglish: free recharge scam',
    language: 'hi-Latn',
    text: `Bhai ye jaldi share kar do sabko! 🎉🎉🎉

Sarkar ne ghoshna kiya hai ki sab logon ko 3 mahine ka free internet dega. Sirf aaj hi last date hai. Neeche wala link par click karo aur register karo: bit.ly/free-data-offer

Apna naam, mobile number aur OTP dalna padega verify karne ke liye. Agar nahi kiya to SIM band ho jayega. Turant karo!`,
  },
  {
    id: 'plausible-release',
    label: 'A message that looks checkable',
    language: 'en',
    text: `Reuters reports that the Reserve Bank of India held the repo rate unchanged at its monetary policy meeting in Mumbai on 6 October. The central bank said the decision was unanimous. Full statement: https://www.rbi.org.in`,
  },
  {
    id: 'ambiguous-short',
    label: 'Short and ambiguous',
    language: 'en',
    text: `They changed the exam pattern again. Please check before you study.`,
  },
];
