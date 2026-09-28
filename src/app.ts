import cors from 'cors';
import express, { Application, NextFunction, Request, Response } from 'express';
import httpStatus from 'http-status';
import cookieParser from 'cookie-parser';
import globalErrorHandler from './app/middlewares/globalErrorHandler';
import router from './app/routes';
import path from 'path';
import { html } from './htmldesign';
import { firebaseLoginHtml } from './firebase-login.html';
import config from './config';

const rawClientUrls = config.base_url_client
  ? config.base_url_client.split(',').map((url) => url.trim())
  : [];

const allowedOrigins = new Set([
  ...rawClientUrls,
  ...rawClientUrls.map((url) => url.replace(/\/+$/, '')),
  'https://sanowarelectric.store',
  'https://www.sanowarelectric.store',
  'http://localhost:3000',
  'http://localhost:3161',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:3161',
].filter(Boolean));

const app: Application = express();

app.set('trust proxy', 1);

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      const normalized = origin.replace(/\/+$/, '');
      if (allowedOrigins.has(origin) || allowedOrigins.has(normalized)) {
        return callback(null, true);
      }
      return callback(null, false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Requested-With',
      'Accept',
      'Origin',
      'x-privileged-token',
      'x-secret-token',
    ],
    optionsSuccessStatus: 200,
  }),
);

app.use(express.json());
app.use(express.json({ limit: '500mb' }));
app.use(express.urlencoded({ limit: '500mb', extended: true }));
app.use(cookieParser());

app.get('/', (req: Request, res: Response) => {
  res.send(html(config.project_name || 'Server'));
});

app.get('/firebase-login', (req: Request, res: Response) => {
  res.send(firebaseLoginHtml);
});

app.use('/api/v1', router);

// Static asset serving for device storage
app.use('/assets', express.static(path.join(process.cwd(), 'assets')));
app.use('/upload', express.static(path.join(__dirname, 'app', 'upload')));

app.use(globalErrorHandler);
app.use((req: Request, res: Response, next: NextFunction) => {
  res.status(httpStatus.NOT_FOUND).json({
    success: false,
    message: 'API NOT FOUND!',
    error: {
      path: req.originalUrl,
      message: 'Your requested path is not found!',
    },
  });
});

export default app;
