// Extend Socket.IO types for our custom data
declare module 'socket.io' {
  interface Socket {
    user?: import('./index').JWTPayload;
    data: {
      claudeSessionId?: string;
    } & import('./index').SocketData;
  }
}