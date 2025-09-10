#!/bin/bash
# Production Setup Script for Claude Code WebUI

set -e

echo "=== Claude Code WebUI Production Setup ==="

# Check if running as root
if [[ $EUID -eq 0 ]]; then
   echo "This script should not be run as root" 
   exit 1
fi

# Configuration
APP_DIR="/opt/claude-webui"
USER="claude"
GROUP="claude"

echo "1. Creating application directories..."
sudo mkdir -p $APP_DIR/server
sudo mkdir -p /var/lib/claude-sessions
sudo mkdir -p /var/log/claude-webui
sudo mkdir -p /etc/ssl/certs
sudo mkdir -p /etc/ssl/private

echo "2. Creating claude user..."
if ! id "$USER" &>/dev/null; then
    sudo useradd -r -s /bin/false -d $APP_DIR $USER
fi

echo "3. Setting up Node.js..."
if ! command -v node &> /dev/null; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt-get install -y nodejs
fi

echo "4. Installing Redis..."
if ! command -v redis-server &> /dev/null; then
    sudo apt-get update
    sudo apt-get install -y redis-server
    sudo systemctl enable redis-server
    sudo systemctl start redis-server
fi

echo "5. Installing Nginx..."
if ! command -v nginx &> /dev/null; then
    sudo apt-get install -y nginx
    sudo systemctl enable nginx
fi

echo "6. Copying application files..."
sudo cp -r . $APP_DIR/server/
sudo chown -R $USER:$GROUP $APP_DIR
sudo chown -R $USER:$GROUP /var/lib/claude-sessions
sudo chown -R $USER:$GROUP /var/log/claude-webui

echo "7. Installing dependencies..."
cd $APP_DIR/server
sudo -u $USER npm ci --production
sudo -u $USER npm run build

echo "8. Setting up systemd service..."
sudo cp systemd/claude-webui.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable claude-webui

echo "9. Setting up Nginx..."
sudo cp nginx.conf /etc/nginx/sites-available/claude-webui
sudo ln -sf /etc/nginx/sites-available/claude-webui /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default

echo "10. Setting up environment..."
if [[ ! -f $APP_DIR/server/.env.production ]]; then
    sudo cp .env.production $APP_DIR/server/
    echo "⚠️  IMPORTANT: Edit $APP_DIR/server/.env.production and set:"
    echo "   - JWT_SECRET (strong random key)"
    echo "   - SSL certificate paths"
    echo "   - Production domain names"
fi

echo "11. Setting up SSL certificates..."
echo "📝 Next steps for SSL:"
echo "   1. Obtain SSL certificates for your domain"
echo "   2. Place them in /etc/ssl/certs/ and /etc/ssl/private/"
echo "   3. Update paths in .env.production"

echo "12. Firewall configuration..."
if command -v ufw &> /dev/null; then
    sudo ufw allow 22/tcp
    sudo ufw allow 80/tcp
    sudo ufw allow 443/tcp
    echo "🔥 Firewall rules added. Enable with: sudo ufw enable"
fi

echo ""
echo "✅ Production setup complete!"
echo ""
echo "🚀 To start the service:"
echo "   sudo systemctl start claude-webui"
echo "   sudo systemctl start nginx"
echo ""
echo "📊 To check status:"
echo "   sudo systemctl status claude-webui"
echo "   sudo journalctl -u claude-webui -f"
echo ""
echo "⚠️  Before starting:"
echo "   1. Configure .env.production with production values"
echo "   2. Set up SSL certificates"
echo "   3. Update domain names in nginx.conf"