// Visual-harness mount entry. Loaded only by visual-harness.html (a dev-time
// page, not a build input). Pulls in the real token CSS so the cards render
// with production styling.
import React from 'react';
import { createRoot } from 'react-dom/client';
import '../styles/index.css';
import { Gallery } from './gallery';

const el = document.getElementById('root');
if (el !== null) {
  createRoot(el).render(
    <React.StrictMode>
      <Gallery />
    </React.StrictMode>,
  );
}
