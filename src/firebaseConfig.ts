// Firebase's web config is meant to live in client-side code — it's not a secret. The real access
// boundary is Firestore's own Security Rules (see docs/store.md or the setup notes), not hiding
// these values. Paste the `firebaseConfig` object shown in Firebase Console →
// Project Settings → General → Your apps → (web app) here, replacing the placeholders below.
export const firebaseConfig = {
  apiKey: "AIzaSyBPMj3EUxaKSFUH5BmSDhnfLhgscf0Ambo",
  authDomain: "gm-notes-sync.firebaseapp.com",
  projectId: "gm-notes-sync",
  storageBucket: "gm-notes-sync.firebasestorage.app",
  messagingSenderId: "2156145409",
  appId: "1:2156145409:web:20947130426053487d8900",
};

// Cloud sync is entirely optional and only activates once this looks like a real config — this lets
// the app run normally (local-only) for anyone who hasn't set up a Firebase project, instead of
// crashing on a bogus "REPLACE_ME" API key.
export function hasFirebaseConfig(): boolean {
  return firebaseConfig.apiKey !== "REPLACE_ME" && !!firebaseConfig.apiKey;
}
