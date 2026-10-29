// The sector list for the screens that show or filter by sector. It is loaded once from the discovery settings, shared
// between screens, and replaced when the sector editor saves.
export function createSectors(api) {
  let list = [];
  let loading = null;
  const load = () => {
    loading ??= api.get('/api/discovery/settings').then((res) => {
      if (res.ok) list = res.data?.sectors ?? [];
      else loading = null; // a failed load is not remembered, so the next screen tries again
      return list;
    });
    return loading;
  };
  return {
    load,
    reload() {
      loading = null;
      return load();
    },
    set(next) {
      list = next;
      loading = Promise.resolve(list);
    },
    list: () => list,
    name: (id) => list.find((s) => s.id === id)?.name ?? id,
  };
}
