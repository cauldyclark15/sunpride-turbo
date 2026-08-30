export const BOOTSTRAP_SUPER_ADMIN_EMAIL = "jcing.jc@gmail.com";

export const normalizeEmail = (email: string) => email.trim().toLowerCase();

export const isBootstrapSuperAdminEmail = (email: string) =>
  normalizeEmail(email) === BOOTSTRAP_SUPER_ADMIN_EMAIL;
