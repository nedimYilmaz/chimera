// Preserve shared film fragments while the homepage is the canonical destination.
location.replace('index.html' + (location.hash || '#demos'));
