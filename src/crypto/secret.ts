import { inspect } from 'node:util';

/**
 * A wrapper that makes accidental disclosure hard: logging, JSON
 * serialisation, string coercion and `util.inspect` all yield "[secret]".
 * The value is obtained only by calling `reveal()` at the point of use.
 */
export class Secret {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  reveal(): string {
    return this.#value;
  }

  get length(): number {
    return this.#value.length;
  }

  /** Last four characters for display, never more. */
  masked(): string {
    const v = this.#value;
    return v.length > 8 ? `••••${v.slice(-4)}` : '••••';
  }

  toString(): string {
    return '[secret]';
  }

  toJSON(): string {
    return '[secret]';
  }

  [inspect.custom](): string {
    return '[secret]';
  }
}
