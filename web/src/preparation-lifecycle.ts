export interface ClosableProof {
  close(): Promise<void>;
}

export class PreparationLifecycle<Proof extends ClosableProof> {
  #active: Proof | undefined;
  #pending = false;

  get active(): Proof | undefined {
    return this.#active;
  }

  tryReplace(create: () => Promise<Proof>): Promise<Proof> | undefined {
    return this.tryExclusive(async () => {
      const previous = this.#active;
      this.#active = undefined;
      await previous?.close();

      const prepared = await create();
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
    const active = this.#active;
    this.#active = undefined;
    await active?.close();
  }
}
