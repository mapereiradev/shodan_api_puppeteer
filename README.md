# Proyecto Node.js — Configuración de .env y Arranque

Este proyecto usa variables de entorno para manejar credenciales y rutas de forma segura.

## Requisitos
- Node.js v16+ (recomendado v18 o v20)
- npm o yarn

## 1) Instalación
```bash
git clone https://github.com/usuario/tu-proyecto.git
cd tu-proyecto
npm install
# o
yarn install

# Credenciales de Shodan
SHODAN_USER=tu_usuario
SHODAN_PASS=tu_password

# Directorio de datos para Puppeteer (opcional)
USER_DATA_DIR=/home/pptruser/.puppeteer-profile
