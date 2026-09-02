export class AppError extends Error {
  constructor(message, exitCode, code) {
    super(message);
    this.name = new.target.name;
    this.exitCode = exitCode;
    this.code = code;
  }
}

export class UsageError extends AppError {
  constructor(message) { super(message, 2, "USAGE"); }
}
export class CapabilityError extends AppError {
  constructor(message) { super(message, 3, "CAPABILITY"); }
}
export class DataIntegrityError extends AppError {
  constructor(message) { super(message, 4, "DATA_INTEGRITY"); }
}
export class OutputError extends AppError {
  constructor(message) { super(message, 5, "OUTPUT"); }
}
