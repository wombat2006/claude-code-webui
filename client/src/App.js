import React, { useState, useEffect, useRef } from 'react';
import { io } from 'socket.io-client';
import './App.css';

function App() {
  const [isConnected, setIsConnected] = useState(false);
  const [messages, setMessages] = useState([]);
  const [inputValue, setInputValue] = useState('');
  const [isSocketConnected, setIsSocketConnected] = useState(false);
  const socketRef = useRef(null);

  const handleLogin = async () => {
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          username: 'demo',
          password: 'demo123'
        })
      });
      
      if (response.ok) {
        const data = await response.json();
        setIsConnected(true);
        setMessages(['Login successful! Connecting to Claude Code...']);
        
        // Initialize Socket.IO connection with JWT token
        initializeSocket(data.token);
      }
    } catch (error) {
      setMessages(['Connection error. Please check if server is running.']);
    }
  };

  const initializeSocket = (token) => {
    const socket = io('/', {
      auth: {
        token: token
      },
      transports: ['websocket', 'polling']
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