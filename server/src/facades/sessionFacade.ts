/**
 * SessionFacade - Stub implementation for sessionManager
 * This facade provides a minimal interface to replace sessionManager calls
 * during the WebUI restoration phase.
 */

export interface SessionData {
  sessionId: string;
  username: string;
  createdAt: number;
  lastActivity: number;
  status: 'active' | 'inactive' | 'expired';
}

export interface SessionFacade {
  createSession(username: string, workingDir: string): Promise<SessionData>;
  getSession(sessionId: string): Promise<SessionData | null>;
  validateSession(sessionId: string): Promise<boolean>;
  refreshSession(sessionId: string): Promise<boolean>;
  addCommandToHistory(sessionId: string, command: string): Promise<void>;
  getSessionStats(): any;
}

/**
 * NoopSessionFacade - Stub implementation that returns safe defaults
 */
export class NoopSessionFacade implements SessionFacade {
  private sessions = new Map<string, SessionData>();
  private sessionCounter = 0;

  async createSession(username: string, workingDir: string): Promise<SessionData> {
    const sessionId = `stub-session-${++this.sessionCounter}`;
    const sessionData: SessionData = {
      sessionId,
      username,
      createdAt: Date.now(),
      lastActivity: Date.now(),
      status: 'active'
    };
    
    this.sessions.set(sessionId, sessionData);
    return sessionData;
  }

  async getSession(sessionId: string): Promise<SessionData | null> {
    return this.sessions.get(sessionId) || null;
  }

  async validateSession(sessionId: string): Promise<boolean> {
    return this.sessions.has(sessionId);
  }

  async refreshSession(sessionId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.lastActivity = Date.now();
      return true;
    }
    return false;
  }

  async addCommandToHistory(sessionId: string, command: string): Promise<void> {
    // Noop - just log for debugging
    console.debug(`[SessionFacade] Command logged for ${sessionId}: ${command.substring(0, 50)}`);
  }

  getSessionStats(): any {
    return {
      totalSessions: this.sessions.size,
      activeSessions: Array.from(this.sessions.values()).filter(s => s.status === 'active').length,
      implementation: 'NoopSessionFacade'
    };
  }
}

// Feature flag to enable/disable session management
const SESSION_ENABLED = process.env.SESSION_ENABLED !== 'false';

// Export singleton instance
export const sessionFacade: SessionFacade = SESSION_ENABLED 
  ? new NoopSessionFacade() // Can be replaced with real implementation later
  : new NoopSessionFacade();