/**
 * `localStorage`, minus the throwing.
 *
 * `localStorage` throws in a sandboxed iframe and in some privacy modes — the
 * same guard `lib/theme.ts` documents. A preference that cannot be stored must
 * degrade to "not remembered", never to a render that throws. Shared by every
 * persisted store in this folder, so the guard is written once.
 */
export const safeStorage: Storage = {
  get length() {
    try {
      return window.localStorage.length;
    } catch {
      return 0;
    }
  },
  key: (index) => {
    try {
      return window.localStorage.key(index);
    } catch {
      return null;
    }
  },
  clear: () => {
    try {
      window.localStorage.clear();
    } catch {
      /* ignored */
    }
  },
  getItem: (key) => {
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  setItem: (key, value) => {
    try {
      window.localStorage.setItem(key, value);
    } catch {
      /* ignored */
    }
  },
  removeItem: (key) => {
    try {
      window.localStorage.removeItem(key);
    } catch {
      /* ignored */
    }
  },
};
