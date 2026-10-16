// Keep the loader tied to requests, rather than to authentication or timers.
export function wrapFirestoreReads(firestore, loading) {
  return {
    getDoc: (...args) => loading.run(() => firestore.getDoc(...args)),
    getDocs: (...args) => loading.run(() => firestore.getDocs(...args)),
    onSnapshot(reference, ...args) {
      const finish = loading.start();
      const observerIndex = args.findIndex((arg) => typeof arg === "function" || (arg && typeof arg === "object" && ("next" in arg || "error" in arg || "complete" in arg)));
      const observer = args[observerIndex];
      const next = typeof observer === "function" ? observer : (...values) => observer?.next?.(...values);
      const error = typeof observer === "function" ? args[observerIndex + 1] : (...values) => observer?.error?.(...values);
      const handleNext = (...values) => {
        try { return next(...values); } finally { finish(); }
      };
      const handleError = (...values) => {
        finish();
        if (typeof error === "function") return error(...values);
        console.error("Firestore listener failed:", ...values);
      };
      if (observerIndex >= 0) {
        if (typeof observer === "function") {
          args[observerIndex] = handleNext;
          args[observerIndex + 1] = handleError;
        } else {
          args[observerIndex] = {
            ...observer,
            next: handleNext,
            error: handleError,
            complete: (...values) => {
              finish();
              return observer.complete?.(...values);
            }
          };
        }
      }
      try {
        const unsubscribe = firestore.onSnapshot(reference, ...args);
        return () => {
          try { unsubscribe(); } finally { finish(); }
        };
      } catch (error) {
        finish();
        throw error;
      }
    }
  };
}
