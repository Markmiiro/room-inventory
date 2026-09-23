import "fake-indexeddb/auto";

/**
 * React needs telling that `act()` is legitimate here.
 *
 * Without it every test that renders into jsdom and waits for a live query
 * prints "The current testing environment is not configured to support
 * act(...)" — a warning that is expected on every such test and therefore
 * drowns the one that is not.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
