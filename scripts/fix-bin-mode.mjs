#!/usr/bin/env node

import { chmodSync } from 'fs';

chmodSync('dist/index.js', 0o755);
