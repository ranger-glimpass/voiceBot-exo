# when code edits,
docker build -t gcr.io/voicebot-exo/voicebot-server .
docker push gcr.io/voicebot-exo/voicebot-server
gcloud run deploy voicebot-server --image gcr.io/voicebot-exo/voicebot-server --platform managed --region us-central1 --allow-unauthenticated --port 3000
