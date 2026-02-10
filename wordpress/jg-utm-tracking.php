<?php
/**
 * Plugin Name: JG Email Agent UTM Tracking
 * Description: Captures UTM params from email links, stores in cookie, attaches to WooCommerce orders.
 *
 * INSTALLATION:
 * Upload this file to your WordPress site at: wp-content/mu-plugins/jg-utm-tracking.php
 * (Create the mu-plugins folder if it doesn't exist — mu-plugins load automatically, no activation needed)
 */

// Capture UTM params on any page load and store in cookie
add_action('init', function () {
    if (isset($_GET['utm_source']) && $_GET['utm_source'] === 'jimmy-email-agent') {
        $utm_data = [
            'utm_source'   => sanitize_text_field($_GET['utm_source']),
            'utm_medium'   => sanitize_text_field($_GET['utm_medium'] ?? ''),
            'utm_campaign' => sanitize_text_field($_GET['utm_campaign'] ?? ''),
            'utm_content'  => sanitize_text_field($_GET['utm_content'] ?? ''),
        ];
        // Store for 30 days — survives browsing sessions
        setcookie('jg_utm', json_encode($utm_data), time() + (30 * 86400), '/', '', true, true);
    }
});

// Attach UTM data to WooCommerce order when it's created
add_action('woocommerce_checkout_order_created', function ($order) {
    if (isset($_COOKIE['jg_utm'])) {
        $utm = json_decode(stripslashes($_COOKIE['jg_utm']), true);
        if ($utm && isset($utm['utm_source']) && $utm['utm_source'] === 'jimmy-email-agent') {
            $order->update_meta_data('_jg_utm_source', $utm['utm_source']);
            $order->update_meta_data('_jg_utm_medium', $utm['utm_medium']);
            $order->update_meta_data('_jg_utm_campaign', $utm['utm_campaign']);
            $order->update_meta_data('_jg_utm_content', $utm['utm_content']); // tracking token
            $order->save();

            // Clear the cookie after attribution
            setcookie('jg_utm', '', time() - 3600, '/', '', true, true);
        }
    }
});

// Include UTM data in WooCommerce REST API order responses
add_filter('woocommerce_rest_prepare_shop_order_object', function ($response, $order) {
    $utm_content = $order->get_meta('_jg_utm_content');
    if ($utm_content) {
        $response->data['meta_data'][] = [
            'key'   => '_jg_utm_content',
            'value' => $utm_content,
        ];
    }
    return $response;
}, 10, 2);

// Also include in FunnelKit/Autonami webhook data if available
add_filter('bwfan_order_data', function ($data, $order_id) {
    $order = wc_get_order($order_id);
    if ($order) {
        $utm_content = $order->get_meta('_jg_utm_content');
        if ($utm_content) {
            $data['meta']['_jg_utm_content'] = $utm_content;
        }
    }
    return $data;
}, 10, 2);
