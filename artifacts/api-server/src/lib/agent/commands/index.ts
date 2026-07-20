/**
 * Deterministic command registry.
 * Each entry is a { name, matches, handle } Command.
 * The webhook iterates these before the LLM agent turn.
 * Commands must be pure: only DB writes + sendToThread, no LLM calls.
 * handle() returns true to stop processing, false to fall through.
 *
 * To add a command:
 *   1. Create lib/agent/commands/myCommand.ts
 *   2. Import and push to COMMANDS below
 */
export interface CommandContext {
  threadId: number; userId: number; content: string; normalizedContent: string; isGroup: boolean;
}
export interface Command {
  name: string;
  matches: (ctx: CommandContext) => boolean;
  handle: (ctx: CommandContext) => Promise<boolean>;
}
export const COMMANDS: Command[] = [];
