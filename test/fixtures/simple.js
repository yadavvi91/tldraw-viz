function processOrder(order) {
	validateOrder(order);
	const total = calculateTotal(order.items);
	applyDiscount(total, order.coupon);
}

function validateOrder(order) {
	if (!order.items || order.items.length === 0) {
		throw new Error('Empty order');
	}
}

function calculateTotal(items) {
	return items.reduce((sum, item) => sum + item.price, 0);
}

function applyDiscount(total, coupon) {
	if (coupon) {
		return total * 0.9;
	}
	return total;
}
