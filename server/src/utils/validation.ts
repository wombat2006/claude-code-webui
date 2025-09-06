// Validation utilities for Claude Code WebUI
// Focused on demo security without over-engineering

// Allowed Claude Code commands (expand as needed)
export const ALLOWED_COMMANDS = new Set([
  'help',
  'init',
  'chat',
  'run',
  'build', 
  'test',
  'lint',
  'format',
  'status',
  'list',
  'show',
  'edit',
  'create',
  'delete',
  'move',
  'copy'
]);

// Characters that could be dangerous in shell contexts
const DANGEROUS_CHARS_REGEX = /[|&;`$()<>!]/;

// Path traversal patterns
const PATH_TRAVERSAL_REGEX = /(^|[\/\\])\.\.(([\/\\])|$)/;

// Maximum lengths for demo use
export const MAX_COMMAND_LENGTH = 100;
export const MAX_ARG_LENGTH = 200;
export const MAX_ARGS_COUNT = 10;
export const MAX_INPUT_LENGTH = 2000;

/**
 * Validate command name - Allow all reasonable commands for Claude Code
 */
export function isValidCommand(command: string): boolean {
  if (!command || typeof command !== 'string') {
    return false;
  }

  const trimmed = command.trim();
  
  if (trimmed.length === 0 || trimmed.length > MAX_COMMAND_LENGTH) {
    return false;
  }

  // Block dangerous shell commands but allow most natural language
  const dangerousCommands = ['rm', 'sudo', 'passwd', 'chmod', 'wget', 'curl'];
  const firstWord = trimmed.split(' ')[0].toLowerCase();
  
  return !dangerousCommands.includes(firstWord);
}

/**
 * Validate command arguments
 */
export function isValidArgs(args: string[]): boolean {
  if (!Array.isArray(args)) {
    return false;
  }

  if (args.length > MAX_ARGS_COUNT) {
    return false;
  }

  for (const arg of args) {
    if (typeof arg !== 'string') {
      return false;
    }

    // Length check
    if (arg.length > MAX_ARG_LENGTH) {
      return false;
    }

    // Check for dangerous characters
    if (DANGEROUS_CHARS_REGEX.test(arg)) {
      return false;
    }

    // Check for path traversal
    if (PATH_TRAVERSAL_REGEX.test(arg)) {
      return false;
    }
  }

  return true;
}

/**
 * Validate terminal input (for sendInput)
 */
export function isValidInput(input: string): boolean {
  if (!input || typeof input !== 'string') {
    return false;
  }

  // Length check
  if (input.length > MAX_INPUT_LENGTH) {
    return false;
  }

  // Prevent null bytes and excessive control characters
  if (input.includes('\0') || input.includes('\r')) {
    return false;
  }

  return true;
}

/**
 * Sanitize command for logging (prevent log injection)
 */
export function sanitizeForLog(text: string, maxLength = 50): string {
  if (!text) return '';
  
  const sanitized = text
    .replace(/[\r\n\t]/g, ' ')
    .replace(/[\x00-\x1F\x7F]/g, '?'); // Replace only control chars, keep Unicode
  
  return sanitized.length > maxLength 
    ? sanitized.substring(0, maxLength) + '...'
    : sanitized;
}