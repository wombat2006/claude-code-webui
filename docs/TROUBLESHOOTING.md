# Troubleshooting Guide

## Common Issues

### Build Errors

**TypeScript compilation fails**
- Check tsconfig.json settings
- Ensure all dependencies are installed: `npm install`
- For demo use: `npm run dev` (skips compilation)

**Port permission denied (EACCES)**
- Use non-privileged port (3001) instead of 443
- Check .env file: `PORT=3001`
- Only nginx should bind to port 443

### Runtime Errors

**WebSocket connection failed**
- Verify server is running on correct port
- Check CORS configuration in server
- Ensure frontend proxy settings match server port

**Authentication errors**
- Verify JWT_SECRET is set correctly
- Check session timeout settings
- Default demo credentials: demo/demo123, admin/admin456

**Claude Code process errors**
- Verify CLAUDE_CODE_PATH points to correct executable
- Check working directory permissions
- Ensure claude-code CLI is installed and accessible

## Development Tips

**Hot reload not working**
- Use `npm run dev` from project root
- Verify concurrently is installed
- Check both client and server are starting

**Build process issues**
- Run `npm run install:all` to install all dependencies
- Use `npm run build` for production builds
- Check TypeScript configuration if compilation fails