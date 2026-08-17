terraform {
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
  }
}

provider "google" {
  project = var.project_id
}

resource "google_project_service" "compute" {
  service            = "compute.googleapis.com"
  disable_on_destroy = false
}

# --- Networking ---

resource "google_compute_firewall" "minecraft" {
  name          = "allow-minecraft"
  network       = "default"
  direction     = "INGRESS"
  source_ranges = ["0.0.0.0/0"] # players connect from anywhere
  allow {
    protocol = "tcp"
    ports    = ["25565"]
  }
  depends_on = [google_project_service.compute]
}

resource "google_compute_firewall" "frp_control" {
  name          = "allow-frp-control"
  network       = "default"
  direction     = "INGRESS"
  source_ranges = ["0.0.0.0/0"]
  allow {
    protocol = "tcp"
    ports    = ["7000"]
  }
  depends_on = [google_project_service.compute]
}

# Bedrock/mobile cross-play, see the README's "Bedrock/mobile cross-play" section.
# Only needed if you're setting that up; harmless to leave in otherwise.
resource "google_compute_firewall" "minecraft_bedrock" {
  name          = "allow-minecraft-bedrock"
  network       = "default"
  direction     = "INGRESS"
  source_ranges = ["0.0.0.0/0"]
  allow {
    protocol = "udp"
    ports    = ["19132"]
  }
  depends_on = [google_project_service.compute]
}

resource "google_compute_firewall" "ssh" {
  name          = "allow-ssh"
  network       = "default"
  direction     = "INGRESS"
  source_ranges = var.ssh_source_ranges
  allow {
    protocol = "tcp"
    ports    = ["22"]
  }
  depends_on = [google_project_service.compute]
}

# Catcher's IP is reserved as its own resource (not the VM's ephemeral default) so it
# survives the VM being recreated. It stays a plain 1:1 NAT address on the VM itself,
# see the README's "Getting the idle cost to (almost) $0" for why this repo stopped
# moving it onto a load balancer forwarding rule (catcher/setup-load-balancer.ts).
resource "google_compute_address" "catcher" {
  name       = "mc-catcher-ip"
  region     = substr(var.catcher_zone, 0, length(var.catcher_zone) - 2)
  depends_on = [google_project_service.compute]
}

# --- Instances ---

resource "google_compute_instance" "catcher" {
  name         = "mc-catcher-vm"
  zone         = var.catcher_zone
  machine_type = "e2-micro" # Always Free eligible in us-west1/us-central1/us-east1
  tags         = ["mc-catcher"]

  # Only settable at creation, gcloud compute instances update can't toggle this
  # after the fact. Was needed for the Bedrock UDP relay's anti-spoofing workaround
  # when catcher sat behind a load balancer (catcher/udp_relay_catcher.ts's own
  # comments have the detail), which this repo no longer sets up by default. Left
  # enabled since it's harmless either way and relay recreation is disruptive to
  # test removing it against; unverified whether it's still required on a plain
  # 1:1 NAT VM, relay itself never set it and its UDP relay works fine, but that
  # hasn't been directly confirmed for catcher's setup specifically.
  can_ip_forward = true

  boot_disk {
    initialize_params {
      image = "debian-cloud/debian-12"
      size  = 10
    }
  }

  network_interface {
    network = "default"
    access_config {
      nat_ip = google_compute_address.catcher.address
    }
  }

  # compute-rw scope + the IAM binding below is what lets catcher_wake_watcher.ts call
  # the Compute API to start the relay VM, authenticated via this VM's own
  # metadata-server token, no key file involved.
  service_account {
    scopes = ["compute-rw"]
  }

  depends_on = [google_project_service.compute]
}

resource "google_compute_instance" "relay" {
  name         = "mc-relay-vm"
  zone         = var.relay_zone
  machine_type = "e2-micro"
  tags         = ["mc-relay"]

  # Stopped by default, this is the on-demand VM, catcher wakes it. Ephemeral IP is
  # intentional (see relay/relay_boot_ddns.ts): it changes on every boot and DNS gets
  # pointed at whatever it currently is.
  desired_status = "TERMINATED"

  boot_disk {
    initialize_params {
      image = "debian-cloud/debian-12"
      size  = 10
    }
  }

  network_interface {
    network = "default"
    access_config {}
  }

  service_account {
    scopes = ["cloud-platform"]
  }

  depends_on = [google_project_service.compute]
}

# Lets catcher's service account start/stop the relay VM specifically, and nothing
# else in the project, rather than granting roles/compute.instanceAdmin.v1 at the
# project level. IAM conditions are how you scope a role to one resource in GCP,
# there's no narrower built-in role than instanceAdmin for start/stop.
resource "google_project_iam_member" "catcher_can_wake_relay" {
  project = var.project_id
  role    = "roles/compute.instanceAdmin.v1"
  member  = "serviceAccount:${google_compute_instance.catcher.service_account[0].email}"

  condition {
    title      = "catcher-can-only-touch-relay"
    expression = "resource.name.endsWith(\"/instances/mc-relay-vm\")"
  }
}
