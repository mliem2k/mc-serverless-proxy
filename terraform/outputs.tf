output "catcher_static_ip" {
  value       = google_compute_address.catcher.address
  description = "Point mc.yourdomain.com's A record at this. Also goes into setup-load-balancer.ts's STATIC_IP_NAME target if you ever move to that setup."
}
