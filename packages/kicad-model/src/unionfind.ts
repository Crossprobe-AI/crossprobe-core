export class UnionFind {
  private parent: number[] = [];

  add(): number {
    this.parent.push(this.parent.length);
    return this.parent.length - 1;
  }

  find(i: number): number {
    let r = i;
    while (this.parent[r] !== r) r = this.parent[r]!;
    while (this.parent[i] !== r) {
      const next = this.parent[i]!;
      this.parent[i] = r;
      i = next;
    }
    return r;
  }

  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[Math.max(ra, rb)] = Math.min(ra, rb);
  }

  get size(): number {
    return this.parent.length;
  }
}
