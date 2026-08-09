export type TelegramCommandCategory =
  | 'chat'
  | 'model'
  | 'shell'
  | 'git'
  | 'queue'
  | 'ops'
  | 'sharing';

export type TelegramCommandEntry = {
  name: string;
  descriptionKey: string;
  category: TelegramCommandCategory;
  /** Highlighted near the top of the palette. */
  suggested?: boolean;
  example?: string;
};

/**
 * Telegram text-command reference for Settings.
 * Mirrors the Discord palette set (`DISCORD_COMMANDS`) plus critique — Telegram
 * has no native slash registration; these are plain `/command` text messages
 * handled by `messenger-commands.js`.
 */
export const TELEGRAM_COMMANDS: TelegramCommandEntry[] = [
  { name: 'help', descriptionKey: 'settings.integrations.telegram.commands.desc.help', category: 'chat' },
  { name: 'status', descriptionKey: 'settings.integrations.telegram.commands.desc.status', category: 'chat', suggested: true },
  { name: 'abort', descriptionKey: 'settings.integrations.telegram.commands.desc.abort', category: 'chat', suggested: true },
  { name: 'new', descriptionKey: 'settings.integrations.telegram.commands.desc.new', category: 'chat' },
  { name: 'undo', descriptionKey: 'settings.integrations.telegram.commands.desc.undo', category: 'chat' },
  { name: 'redo', descriptionKey: 'settings.integrations.telegram.commands.desc.redo', category: 'chat' },
  { name: 'model', descriptionKey: 'settings.integrations.telegram.commands.desc.model', category: 'model', suggested: true },
  { name: 'agent', descriptionKey: 'settings.integrations.telegram.commands.desc.agent', category: 'model' },
  { name: 'verbosity', descriptionKey: 'settings.integrations.telegram.commands.desc.verbosity', category: 'model' },
  { name: 'yolo', descriptionKey: 'settings.integrations.telegram.commands.desc.yolo', category: 'model', suggested: true },
  {
    name: 'permissions',
    descriptionKey: 'settings.integrations.telegram.commands.desc.permissions',
    category: 'model',
  },
  { name: 'skill', descriptionKey: 'settings.integrations.telegram.commands.desc.skill', category: 'model' },
  { name: 'login', descriptionKey: 'settings.integrations.telegram.commands.desc.login', category: 'model', suggested: true },
  {
    name: 'session',
    descriptionKey: 'settings.integrations.telegram.commands.desc.session',
    category: 'chat',
    suggested: true,
    example: '/session Fix the login form validation',
  },
  { name: 'resume', descriptionKey: 'settings.integrations.telegram.commands.desc.resume', category: 'chat' },
  { name: 'fork', descriptionKey: 'settings.integrations.telegram.commands.desc.fork', category: 'chat' },
  { name: 'queue', descriptionKey: 'settings.integrations.telegram.commands.desc.queue', category: 'queue' },
  { name: 'clear-queue', descriptionKey: 'settings.integrations.telegram.commands.desc.clearQueue', category: 'queue' },
  { name: 'mention-mode', descriptionKey: 'settings.integrations.telegram.commands.desc.mentionMode', category: 'queue' },
  { name: 'diff', descriptionKey: 'settings.integrations.telegram.commands.desc.diff', category: 'git', suggested: true },
  {
    name: 'critique',
    descriptionKey: 'settings.integrations.telegram.commands.desc.critique',
    category: 'git',
    suggested: true,
    example: '/critique on',
  },
  { name: 'usage', descriptionKey: 'settings.integrations.telegram.commands.desc.usage', category: 'chat', suggested: true },
  { name: 'credits', descriptionKey: 'settings.integrations.telegram.commands.desc.credits', category: 'chat' },
  { name: 'shell', descriptionKey: 'settings.integrations.telegram.commands.desc.shell', category: 'shell', example: '/shell pwd' },
  { name: 'new-worktree', descriptionKey: 'settings.integrations.telegram.commands.desc.newWorktree', category: 'git' },
  { name: 'merge-worktree', descriptionKey: 'settings.integrations.telegram.commands.desc.mergeWorktree', category: 'git' },
  { name: 'share', descriptionKey: 'settings.integrations.telegram.commands.desc.share', category: 'sharing' },
  {
    name: 'schedule',
    descriptionKey: 'settings.integrations.telegram.commands.desc.schedule',
    category: 'sharing',
    suggested: true,
    example: '/schedule 0 9 * * 1 Weekly standup report',
  },
  { name: 'reload-opencode', descriptionKey: 'settings.integrations.telegram.commands.desc.reloadOpencode', category: 'ops' },
];

export const TELEGRAM_COMMAND_CATEGORY_ORDER: TelegramCommandCategory[] = [
  'chat',
  'model',
  'shell',
  'git',
  'queue',
  'ops',
  'sharing',
];
