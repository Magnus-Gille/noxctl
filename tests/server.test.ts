import { describe, it, expect } from 'vitest';
import { createServer } from '../src/index.js';

describe('MCP server', () => {
  it('creates a server instance', () => {
    const server = createServer();
    expect(server).toBeDefined();
  });
});
