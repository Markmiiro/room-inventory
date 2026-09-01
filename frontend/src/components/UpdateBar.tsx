import { useEffect, useState } from "react";
import { useRegisterSW } from "virtual:pwa-register/react";

/**
 * SPEC 9 — "a new service worker shows a small 'Update available' bar rather
 * than reloading under the user's hands mid-entry."
 *
 * Reloading on its own would be worse here than anywhere: the user is often
 * halfway through typing a tag while standing next to the animal it belongs to,
 * and a reload loses the form. So the new version waits until it is asked for.
 */
export function UpdateBar() {
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW(_url, registration) {
      // Check for a new version on load and then hourly. The app is used for
      // long stretches with the tab left open.
      if (registration) {
        setInterval(() => void registration.update(), 60 * 60 * 1000);
      }
    },
  });

  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);
  if (!ready || !needRefresh) return null;

  return (
    <div
      role="status"
      className="fixed inset-x-0 bottom-0 z-50 bg-primary text-white p-3 flex items-center gap-3 shadow-card-up"
    >
      <p className="text-body-md flex-1">A new version is ready.</p>
      <button
        type="button"
        className="btn-quiet min-h-touch"
        onClick={() => setNeedRefresh(false)}
      >
        Later
      </button>
      <button
        type="button"
        className="btn-action min-h-touch"
        onClick={() => void updateServiceWorker(true)}
      >
        Update
      </button>
    </div>
  );
}
