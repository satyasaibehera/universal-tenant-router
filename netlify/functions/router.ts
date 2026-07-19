import 'dotenv/config';
import express from 'express';
import serverless from 'serverless-http';
import { createApp } from '../../src/app';

const app = express();
const coreApp = createApp();

// Strip away the Netlify execution prefix so your original routes map perfectly
app.use('/.netlify/functions/router', coreApp);

// Fallback rule for standard local execution proxies
app.use('/', coreApp);

export const handler = serverless(app);