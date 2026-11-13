// 極簡事件匯流排：成長的 hook（例如 onDriftEnd）之後也掛在這裡。
export function createEvents() {
  const map = new Map();
  return {
    on(name, fn) {
      if (!map.has(name)) map.set(name, []);
      map.get(name).push(fn);
      return () => {
        const list = map.get(name);
        const i = list.indexOf(fn);
        if (i >= 0) list.splice(i, 1);
      };
    },
    emit(name, payload) {
      const list = map.get(name);
      if (list) for (const fn of list) fn(payload);
    },
  };
}
