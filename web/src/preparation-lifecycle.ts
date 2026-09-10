export interface ClosableProof {
  close(): Promise<void>;
}

export class PreparationLifecycle<Proof extends ClosableProof> {
  #active: Proof | undefined;
  #pending = false;
  #generation = 0;
  #abort: AbortController | undefined;

  get active(): Proof | undefined {
    return this.#active;
  }

  tryReplace(create: (signal: AbortSignal) => Promise<Proof>): Promise<Proof> | undefined {
    const generation = this.#generation;
    return this.tryExclusive(async () => {
      const previous = this.#active;
      this.#active = undefined;
      await previous?.close();

      if (generation !== this.#generation) throw new Error("Preparation cancelled");
      const controller = new AbortController();
      this.#abort = controller;
      const prepared = await create(controller.signal).finally(() => { this.#abort = undefined; });
      if (generation !== this.#generation) {
        await prepared.close();
        throw new Error("Preparation cancelled");
      }
      this.#active = prepared;
      return prepared;
    });
  }

  tryExclusive<Result>(run: () => Promise<Result>): Promise<Result> | undefined {
    if (this.#pending) {
      return undefined;
    }
    this.#pending = true;
    return Promise.resolve()
      .then(run)
      .finally(() => {
        this.#pending = false;
      });
  }

  async closeActive(): Promise<void> {
    this.#generation += 1;
    this.#abort?.abort();
    const active = this.#active;
    this.#active = undefined;
    await active?.close();
  }
}
