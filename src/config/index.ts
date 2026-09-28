import dotenv from 'dotenv';
import path from 'path';

const nodeEnv =
  process.env.NODE_ENV === 'production' ? 'production' : 'development';

dotenv.config({ path: path.join(process.cwd(), '.env') });
dotenv.config({
  path: path.join(process.cwd(), `.env.${nodeEnv}`),
  override: true,
});

const buildLocalDatabaseUrl = () => {
  const slug = process.env.PROJECT_SLUG;
  const user = process.env.POSTGRES_USER;
  const password = process.env.POSTGRES_PASSWORD;
  const port = process.env.POSTGRES_PORT;
  if (!slug || !user || !password || !port) {
    return undefined;
  }
  return `postgresql://${user}:${encodeURIComponent(password)}@localhost:${port}/${slug}?schema=public`;
};

if (!process.env.DATABASE_URL) {
  const localUrl = buildLocalDatabaseUrl();
  if (localUrl) {
    process.env.DATABASE_URL = localUrl;
  }
}

export default {
  env: process.env.NODE_ENV,
  project_name: process.env.PROJECT_NAME || '',
  project_slug: process.env.PROJECT_SLUG || '',
  port: process.env.PORT,
  database_url: process.env.DATABASE_URL,
  super_admin_password: process.env.SUPER_ADMIN_PASSWORD,
  bcrypt_salt_rounds: process.env.BCRYPT_SALT_ROUNDS,
  mail: process.env.MAILTRAP_USER,
  mail_password: process.env.MAILTRAP_PASSWORD,
  mail_port: process.env.MAILTRAP_PORT,
  base_url_server: process.env.BASE_URL_SERVER,
  base_url_client: process.env.BASE_URL_CLIENT,
  secret_admin_token: process.env.SECRET_ADMIN_TOKEN || '',
  allow_privileged_access:
    process.env.ALLOW_PRIVILEGED_ACCESS === 'true' ||
    process.env.NODE_ENV !== 'production',
  jwt: {
    access_secret: process.env.JWT_ACCESS_SECRET,
    access_expires_in: process.env.JWT_ACCESS_EXPIRES_IN,
    refresh_secret: process.env.JWT_REFRESH_SECRET,
    refresh_expires_in: process.env.JWT_REFRESH_EXPIRES_IN,
  },
  session: {
    cookie_name: 'sid',
    idle_ms: 7 * 24 * 60 * 60 * 1000,
    absolute_ms: 30 * 24 * 60 * 60 * 1000,
    touch_after_ms: 60 * 60 * 1000,
  },
  firebase: {
    type: process.env.FIREBASE_TYPE,
    project_id: process.env.FIREBASE_PROJECT_ID,
    private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
    private_key: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    client_email: process.env.FIREBASE_CLIENT_EMAIL,
    client_id: process.env.FIREBASE_CLIENT_ID,
    auth_uri: process.env.FIREBASE_AUTH_URI,
    token_uri: process.env.FIREBASE_TOKEN_URI,
    auth_provider_x509_cert_url:
      process.env.FIREBASE_AUTH_PROVIDER_X509_CERT_URL,
    client_x509_cert_url: process.env.FIREBASE_CLIENT_X509_CERT_URL,
    universe_domain: process.env.FIREBASE_UNIVERSE_DOMAIN,
    web_api_key: process.env.FIREBASE_WEB_API_KEY,
    web_auth_domain: process.env.FIREBASE_WEB_AUTH_DOMAIN,
    web_storage_bucket: process.env.FIREBASE_WEB_STORAGE_BUCKET,
    web_messaging_sender_id: process.env.FIREBASE_WEB_MESSAGING_SENDER_ID,
    web_app_id: process.env.FIREBASE_WEB_APP_ID,
    web_measurement_id: process.env.FIREBASE_WEB_MEASUREMENT_ID,
  },
  cloudinary: {
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
    project_name: process.env.CLOUDINARY_PROJECT_NAME,
  },
  mi_space: {
    endpoints: process.env.MI_SPACE_ENDPOINT,
    access_key: process.env.MI_SPACE_ACCESS_KEY,
    secret_key: process.env.MI_SPACE_SECRET_KEY,
    bucket: process.env.MI_SPACE_BUCKET,
    port: process.env.MI_PORT,
    ssl: process.env.MI_USE_SSL,
  },
};
