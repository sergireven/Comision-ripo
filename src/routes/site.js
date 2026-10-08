const express = require('express');

// Web pública de la comisión: portada y «Qui som». No requieren iniciar sesión.
module.exports = function siteRoutes({ db }) {
  const router = express.Router();

  router.get('/', (req, res) => {
    const products = db.prepare('SELECT * FROM products WHERE active = 1 ORDER BY created_at DESC, id DESC LIMIT 4').all();
    res.render('site/home', { title: 'Inicio', products });
  });

  router.get('/qui-som', (req, res) => {
    res.render('site/about', { title: 'Quiénes somos' });
  });

  return router;
};
