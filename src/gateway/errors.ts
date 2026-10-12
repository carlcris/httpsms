export class GatewayError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly retryAfter?: number,
  ) {
    super(message);
    this.name = "GatewayError";
  }
}
