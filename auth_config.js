/* ==========================================================================
 * auth_config.js — Lista blanca de correos con acceso al tablero
 * --------------------------------------------------------------------------
 * auth.js normaliza cada correo (trim + toLowerCase) antes de comparar, así
 * que mayúsculas o espacios accidentales no afectan el acceso.
 *
 * IMPORTANTE: es un control de acceso de interfaz, no de seguridad. Este
 * archivo es público (cualquiera puede leerlo desde el navegador). Ver
 * PROJECT_CONTEXT.md → "Alcance de la autenticación".
 * ========================================================================== */
window.ALLOWED_EMAILS = [
  'ivan.hincapie@cipa.com',
  'analista@empresa.com',
  'admin@empresa.com',
];
