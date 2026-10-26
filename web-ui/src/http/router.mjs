// Tiny method + path router. Patterns are exact strings or RegExps whose
// capture groups are passed to the handler as `params`.
export class Router {
  #routes = [];

  add(method, pattern, handler) {
    this.#routes.push({ method, pattern, handler });
    return this;
  }

  get(pattern, handler) { return this.add('GET', pattern, handler); }
  post(pattern, handler) { return this.add('POST', pattern, handler); }
  put(pattern, handler) { return this.add('PUT', pattern, handler); }
  delete(pattern, handler) { return this.add('DELETE', pattern, handler); }

  match(method, pathName) {
    for (const route of this.#routes) {
      if (route.method !== method) continue;
      if (typeof route.pattern === 'string') {
        if (route.pattern === pathName) return { handler: route.handler, params: [] };
      } else {
        const found = route.pattern.exec(pathName);
        if (found) return { handler: route.handler, params: found.slice(1) };
      }
    }
    return null;
  }
}
