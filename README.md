# Kiese Backend

Ce projet est le backend Node.js pour l'application Kiese (chauffeurs et clients).

## Technologies

- Node.js + Express
- PostgreSQL
- Railway (hébergement backend + base de données)
- Twilio (SMS OTP)

## Routes principales

- `POST /api/driver/:phone/request_otp`
- `POST /api/driver/:phone/verify_otp`
- `GET /api/driver/:phone/availability`
- `POST /api/ride/create_negociation`
- `POST /api/ride/:id/confirm_price`
- `GET /api/ride/:id/details`
- `GET /api/ride/:id/discussion`

## Variables d’environnement

Voir le fichier `.env.example` pour configurer l’environnement.

## Déploiement

Le backend est automatiquement déployé depuis ce dépôt via [Railway](https://railway.app).
