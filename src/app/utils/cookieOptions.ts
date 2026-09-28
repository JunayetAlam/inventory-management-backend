import { CookieOptions, Response } from 'express';
import config from '../../config';

export const getBaseCookieOptions = (): CookieOptions => {
  const isHttps =
    process.env.COOKIE_SECURE === 'true' ||
    Boolean(
      config.base_url_server?.startsWith('https://') ||
        config.base_url_client?.startsWith('https://'),
    );

  const isExplicitlyInsecure =
    process.env.COOKIE_SECURE === 'false' ||
    (!isHttps &&
      Boolean(
        config.base_url_server?.startsWith('http://') ||
          config.base_url_client?.startsWith('http://'),
      ));

  const isSecure =
    process.env.COOKIE_SECURE !== undefined
      ? process.env.COOKIE_SECURE === 'true'
      : isHttps && !isExplicitlyInsecure;

  // On plain HTTP (e.g. VPS with IP address), browsers reject `sameSite: 'none'`
  // because `none` requires `secure: true`. Thus default to 'lax' on HTTP.
  const sameSite: CookieOptions['sameSite'] =
    (process.env.COOKIE_SAMESITE as CookieOptions['sameSite']) ||
    (isSecure ? 'none' : 'lax');

  const cookieDomain = process.env.COOKIE_DOMAIN?.trim();

  const options: CookieOptions = {
    httpOnly: true,
    secure: isSecure,
    sameSite,
    path: '/',
  };

  if (cookieDomain) {
    options.domain = cookieDomain;
  }

  return options;
};

const sessionCookieMaxAge = (createdAt: Date) => {
  const remainingAbsolute =
    createdAt.getTime() + config.session.absolute_ms - Date.now();
  return Math.max(0, Math.min(config.session.idle_ms, remainingAbsolute));
};

export const setSessionCookie = (
  res: Response,
  sid: string,
  createdAt: Date,
) => {
  const maxAge = sessionCookieMaxAge(createdAt);
  if (maxAge <= 0) {
    clearAuthCookies(res);
    return;
  }

  res.cookie(config.session.cookie_name, sid, {
    ...getBaseCookieOptions(),
    maxAge,
  });
};

export const clearAuthCookies = (res: Response) => {
  res.clearCookie(config.session.cookie_name, getBaseCookieOptions());
};
