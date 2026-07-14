export class PlanForgeError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "PlanForgeError";
    this.code = code;
  }
}
