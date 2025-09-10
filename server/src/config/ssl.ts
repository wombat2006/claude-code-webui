import fs from 'fs';
import https from 'https';
import { ServerConfig } from '../types';
import logger from './logger';
import { getErrorMessage } from '../utils/errorHandling';

// SSL/TLS Configuration for HTTPS server
export const createSSLOptions = (config: ServerConfig): https.ServerOptions | null => {
  const { sslCertPath, sslKeyPath } = config;

  // Skip SSL in development unless explicitly configured
  if (process.env.NODE_ENV === 'development' && (!sslCertPath || !sslKeyPath)) {
    logger.warn('Running in development mode without SSL certificates');
    return null;
  }

  // Production requires SSL certificates
  if (process.env.NODE_ENV === 'production' && (!sslCertPath || !sslKeyPath)) {
    throw new Error('SSL certificates are required in production. Set SSL_CERT_PATH and SSL_KEY_PATH');
  }

  if (!sslCertPath || !sslKeyPath) {
    return null;
  }

  try {
    // Check if certificate files exist
    if (!fs.existsSync(sslCertPath)) {
      throw new Error(`SSL certificate not found: ${sslCertPath}`);
    }

    if (!fs.existsSync(sslKeyPath)) {
      throw new Error(`SSL private key not found: ${sslKeyPath}`);
    }

    const cert = fs.readFileSync(sslCertPath, 'utf8');
    const key = fs.readFileSync(sslKeyPath, 'utf8');

    // Optional: Read intermediate certificates
    const intermediateCertPath = process.env.SSL_INTERMEDIATE_CERT_PATH;
    let ca: string[] | undefined;
    
    if (intermediateCertPath && fs.existsSync(intermediateCertPath)) {
      ca = [fs.readFileSync(intermediateCertPath, 'utf8')];
      logger.info('Loaded intermediate certificate', { path: intermediateCertPath });
    }

    const sslOptions: https.ServerOptions = {
      key,
      cert,
      ca,
      // Security configurations
      secureProtocol: 'TLSv1_2_method', // TLS 1.2+
      honorCipherOrder: true,
      ciphers: [
        'ECDHE-RSA-AES128-GCM-SHA256',
        'ECDHE-RSA-AES256-GCM-SHA384',
        'ECDHE-RSA-AES128-SHA256',
        'ECDHE-RSA-AES256-SHA384'
      ].join(':'),
      ecdhCurve: 'prime256v1:secp384r1:secp521r1'
    };

    logger.info('SSL certificates loaded successfully', {
      certPath: sslCertPath,
      keyPath: sslKeyPath,
      hasIntermediate: !!ca
    });

    return sslOptions;
  } catch (error) {
    const errorMessage = error instanceof Error ? getErrorMessage(error) : 'Unknown error';
    logger.error('Failed to load SSL certificates', error instanceof Error ? error : new Error(String(error)));
    throw new Error(`SSL configuration error: ${errorMessage}`);
  }
};

// Self-signed certificate generator for development
export const generateSelfSignedCert = (): { cert: string; key: string } => {
  // This is a placeholder - in practice, you'd use a library like node-forge
  // or have developers generate their own certificates
  logger.warn('Self-signed certificate generation not implemented');
  logger.info('For development, generate certificates manually:', {
    command: 'openssl req -x509 -newkey rsa:4096 -keyout key.pem -out cert.pem -days 365 -nodes'
  });
  
  throw new Error('Self-signed certificate generation not implemented. Please provide SSL certificates.');
};