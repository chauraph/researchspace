/**
 * Logs in through the Shiro form once and saves the session, so every probe
 * starts inside the application instead of at the login page.
 */

import { test as setup, expect } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';

const authFile = path.join('.auth', 'user.json');

setup('authenticate', async ({ page }) => {
  const user = process.env.RS_USER ?? 'admin';
  const password = process.env.RS_PASSWORD ?? 'admin';

  await expect
    .poll(async () => (await page.request.get('/login')).status(), { timeout: 90_000 })
    .toBe(200);

  await page.goto('/login');
  await page.getByPlaceholder('Username').fill(user);
  await page.getByPlaceholder('Password').fill(password);
  await page.getByRole('button', { name: 'Login' }).click();
  await expect(page).not.toHaveURL(/\/login/);

  const me = await (await page.request.get('/rest/security/user')).json();
  expect(me.isAuthenticated).toBe(true);

  fs.mkdirSync(path.dirname(authFile), { recursive: true });
  await page.context().storageState({ path: authFile });
});
