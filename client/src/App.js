import React, { useState, useEffect, useRef } from 'react';
import { io } from 'socket.io-client';
import Dashboard from './components/Dashboard';
import LLMCollaboration from './components/LLMCollaboration';
import './App.css';

function App() {
  const [isConnected, setIsConnected] = useState(false);
  const [messages, setMessages] = useState([]);
  const [inputValue, setInputValue] = useState('');
  const [isSocketConnected, setIsSocketConnected] = useState(false);
  const socketRef = useRef(null);

  const handleLogin = async () => {
    try {
      // Skip authentication for development mode
      setIsConnected(true);
      setMessages(['Development mode: Connecting to Claude Code...']);
      
      // Initialize Socket.IO connection
      initializeSocket();
    } catch (error) {
      setMessages(['Connection error. Please check if server is running.']);
    }
  };

  const initializeSocket = () => {
    const socket = io('https://techsapo.com', {
      path: '/socket.io',
      transports: ['websocket', 'polling'],
      secure: true
    });

    socketRef.current = socket;

    socket.on('connect', () => {
      setIsSocketConnected(true);
      setMessages(prev => [...prev, 'Connected to Claude Code WebUI!']);
    });

    socket.on('connected', (data) => {
      setMessages(prev => [...prev, `Claude Code session started: ${data.sessionId}`]);
    });

    socket.on('commandOutput', (data) => {
      if (data.output) {
        setMessages(prev => [...prev, data.output]);
      }
      if (data.error) {
        setMessages(prev => [...prev, `Error: ${data.error}`]);
      }
    });

    socket.on('commandComplete', (data) => {
      setMessages(prev => [...prev, `Command completed (exit code: ${data.exitCode})`]);
    });

    socket.on('error', (data) => {
      setMessages(prev => [...prev, `Error: ${data.message}`]);
    });

    socket.on('disconnect', () => {
      setIsSocketConnected(false);
      setMessages(prev => [...prev, 'Disconnected from Claude Code']);
    });
  };

  const sendCommand = () => {
    if (inputValue.trim() && socketRef.current && isSocketConnected) {
      setMessages(prev => [...prev, `> ${inputValue}`]);
      socketRef.current.emit('executeCommand', { command: inputValue });
      setInputValue('');
    }
  };

  useEffect(() => {
    return () => {
      if (socketRef.current) {
        socketRef.current.disconnect();
      }
    };
  }, []);

  return (
    <div className="App">
      <header className="App-header">
        <h1>Claude Code WebUI</h1>
        <p>Web interface for Claude Code CLI</p>
        
        {/* Dashboard and LLM Collaboration available when connected */}
        {isConnected && (
          <>
            <Dashboard 
              socket={socketRef.current} 
              isConnected={isSocketConnected} 
            />
            <LLMCollaboration
              socket={socketRef.current}
              isConnected={isSocketConnected}
            />
          </>
        )}
        
        {!isConnected ? (
          <div>
            <button onClick={handleLogin} className="login-button">
              Login (demo/demo123)
            </button>
          </div>
        ) : (
          <div className="terminal">
            <div className="connection-status">
              Status: {isSocketConnected ? '🟢 Connected' : '🔴 Connecting...'}
            </div>
            <div className="terminal-output">
              {messages.map((msg, index) => (
                <div key={index} className="terminal-line">{msg}</div>
              ))}
            </div>
            <div className="terminal-input">
              <span>$ </span>
              <input
                type="text"
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                onKeyPress={(e) => e.key === 'Enter' && sendCommand()}
                placeholder={isSocketConnected ? "Enter command..." : "Connecting to Claude Code..."}
                disabled={!isSocketConnected}
              />
              <button 
                onClick={sendCommand} 
                disabled={!isSocketConnected || !inputValue.trim()}
              >
                Send
              </button>
            </div>
          </div>
        )}
      </header>
    </div>
  );
}

export default App;