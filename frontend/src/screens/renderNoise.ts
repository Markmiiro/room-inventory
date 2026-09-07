/**
 * Silence one known, benign warning in the static-render smoke tests.
 *
 * `renderToStaticMarkup` warns that `useLayoutEffect` does nothing on the
 * server. React Router calls it, and these tests render statically on purpose:
 * they check that a screen produces markup at all, not that it hydrates. The
 * warning is therefore expected on every render and drowns the test output,
 * which is how a real warning goes unnoticed.
 *
 * Only that one message is dropped. Anything else React says still reaches the
 * console, because the point of these tests is to hear it.
 */
export function muteLayoutEffectWarning(): () => void {
  const original = console.error;
  console.error = (...args: unknown[]) => {
    if (typeof args[0] === "string" && args[0].includes("useLayoutEffect does nothing on the server")) {
      return;
    }
    original(...args);
  };
  return () => {
    console.error = original;
  };
}
