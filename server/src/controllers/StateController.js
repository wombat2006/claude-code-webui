/**
 * State Controller
 * Handles session state management endpoints
 */

const BaseController = require('./BaseController');

class StateController extends BaseController {
  constructor(options = {}) {
    super(options);
    this.stateSync = options.stateSync;
    
    if (!this.stateSync) {
      throw new Error('StateSync service is required for StateController');
    }
  }

  /**
   * Save state for a session
   * POST /state/:sessionId
   */
  saveState = this.asyncHandler(async (req, res) => {
    const { sessionId } = req.params;
    const stateData = req.body;
    
    this.log('Saving state', { sessionId });

    const result = await this.stateSync.saveState(sessionId, stateData);
    
    return this.successResponse(res, result, `State saved for session ${sessionId}`);
  });

  /**
   * Get state for a session
   * GET /state/:sessionId
   */
  getState = this.asyncHandler(async (req, res) => {
    const { sessionId } = req.params;
    
    this.log('Retrieving state', { sessionId });

    const state = await this.stateSync.getState(sessionId);
    
    if (!state) {
      return res.status(404).json({
        success: false,
        error: `Session ${sessionId} not found`,
        timestamp: new Date().toISOString()
      });
    }
    
    return this.successResponse(res, state, `State retrieved for session ${sessionId}`);
  });

  /**
   * Update state for a session with version control
   * PUT /state/:sessionId
   */
  updateState = this.asyncHandler(async (req, res) => {
    const { sessionId } = req.params;
    const { data, expectedVersion } = req.body;
    
    this.log('Updating state', { sessionId, expectedVersion });

    const result = await this.stateSync.updateState(sessionId, data, expectedVersion);
    
    return this.successResponse(res, result, `State updated for session ${sessionId}`);
  });

  /**
   * List all sessions and stats
   * GET /state
   */
  getStateStats = this.asyncHandler(async (req, res) => {
    this.log('Retrieving state statistics');

    const sessions = await this.stateSync.listSessions();
    const stats = this.stateSync.getSyncStats();
    const liveState = this.stateSync.getLiveState();
    
    const statsData = {
      sessions,
      stats,
      liveState
    };
    
    return this.successResponse(res, statsData, 'State sync statistics');
  });

  /**
   * Cross-region state sync
   * POST /state/sync/:sessionId
   */
  syncState = this.asyncHandler(async (req, res) => {
    const { sessionId } = req.params;
    const { remoteUrl } = req.body;
    
    this.validateRequired(req, ['remoteUrl']);
    
    this.log('Starting cross-region sync', { sessionId, remoteUrl });

    // Get local state
    const localState = await this.stateSync.getState(sessionId);
    if (!localState) {
      return res.status(404).json({
        success: false,
        error: `Session ${sessionId} not found locally`,
        timestamp: new Date().toISOString()
      });
    }

    // Attempt to sync with remote region
    const syncResult = await this.stateSync.syncWithRemoteRegion(remoteUrl, sessionId);
    
    const syncData = {
      localState,
      syncResult
    };
    
    return this.successResponse(res, syncData, `Cross-region sync attempted for ${sessionId}`);
  });

  /**
   * Receive state from remote region
   * POST /state/receive/:sessionId
   */
  receiveState = this.asyncHandler(async (req, res) => {
    const { sessionId } = req.params;
    const remoteState = req.body;
    
    this.log('Receiving state from remote region', {
      sessionId,
      remoteRegion: remoteState.region,
      remoteVersion: remoteState.version
    });

    // Get local state to check version
    const localState = await this.stateSync.getState(sessionId);
    
    if (!localState || remoteState.timestamp > localState.timestamp) {
      // Remote state is newer, update local
      const result = await this.stateSync.saveState(sessionId, remoteState.data, {
        version: remoteState.version,
        syncedFrom: remoteState.region,
        originalTimestamp: remoteState.timestamp
      });
      
      const updateData = {
        action: 'updated',
        result
      };
      
      return this.successResponse(res, updateData, `Local state updated from ${remoteState.region}`);
    } else {
      // Local state is newer or same, send back local
      const localData = {
        action: 'local_newer',
        localState
      };
      
      return this.successResponse(res, localData, 'Local state is newer, no update needed');
    }
  });

  /**
   * Test session snapshot creation
   * POST /snapshot/test/:sessionId
   */
  testSnapshot = this.asyncHandler(async (req, res) => {
    const { sessionId } = req.params;
    const { command, stdout, stderr, exitCode } = req.body;

    this.log('Testing session snapshot creation', { sessionId, command });

    // Simulate command execution result
    const commandResult = {
      stdout: stdout || 'Test command executed successfully',
      stderr: stderr || '',
      exitCode: exitCode || 0,
      cwd: '/ai/prj/claude-code-webui',
      duration: 150
    };

    // Note: In production, this would register with snapshotWriter
    // For now, we'll just return the simulation
    const result = {
      success: true,
      message: `Session snapshot test initiated for ${sessionId}`,
      command: command || 'npm test',
      result: commandResult
    };

    return this.successResponse(res, result);
  });

  /**
   * Register routes for this controller
   */
  registerRoutes(app) {
    app.post('/state/:sessionId', this.saveState);
    app.get('/state/:sessionId', this.getState);
    app.put('/state/:sessionId', this.updateState);
    app.get('/state', this.getStateStats);
    app.post('/state/sync/:sessionId', this.syncState);
    app.post('/state/receive/:sessionId', this.receiveState);
    app.post('/snapshot/test/:sessionId', this.testSnapshot);
    
    this.log('State routes registered', {
      routes: [
        'POST /state/:sessionId',
        'GET /state/:sessionId', 
        'PUT /state/:sessionId',
        'GET /state',
        'POST /state/sync/:sessionId',
        'POST /state/receive/:sessionId',
        'POST /snapshot/test/:sessionId'
      ]
    });
  }
}

module.exports = StateController;